/*
 * greplost benchmark oracle: compiler-grade Java truth (spec 2026-09-04, sections 1.6 and 5.2).
 *
 * The structure layer is never scored against itself (tech spec 10.1, principle 2), so this
 * program shares no code, and no idea, with greplost's extractor. It is javac: the
 * `com.sun.source` Compiler Tree API drives a real `JavacTask` over the corpus's own sources,
 * with `-proc:none` and a classpath of exactly those sources, and every answer below is the
 * compiler's own — `Trees.getElement` for a call, `Elements.getAllMembers` for an export.
 *
 * It prints one JSON document on stdout, in greplost's id vocabulary (tech spec 5.3):
 *
 *   files    the requested files javac parsed *and* type-checked without an error;
 *   imports  one edge per (importing file, imported file), from the unit's own import list;
 *   exports  file -> the public names it declares: `Store`, `Store.put`, `Store.Entry`;
 *   calls    edges between symbol ids, from every method invocation and every `new`;
 *   errors   one line per file javac reported an error in; those files are dropped from
 *            `files`, so a file the compiler never fully saw is never scored;
 *   units    how many compilation units were parsed at all, so an empty run is an error
 *            rather than four vacuous 1.000s.
 *
 * Three vocabulary rules, each a consequence of what a *declaration* is:
 *
 *  - a name is dotted from its top-level type down: `Store`, `Store.Entry`, `Store.Entry.key`.
 *    A member of an anonymous or local class has no such name, so a call into one, or out of
 *    one, is attributed to the nearest enclosing named method or type instead;
 *  - a constructor is `<Type>.<simple name of Type>`; a constructor javac generated rather
 *    than read (a default constructor, a record's canonical one) is not a declaration at all,
 *    so a `new` of such a type points at the type;
 *  - a member javac synthesised — a record accessor, an enum's `values` — has no source
 *    declaration either, so it is never an export and never a call target.
 *
 * One deliberate omission, the mirror of a rule in `packages/core/src/resolve/java.ts`: a
 * member name declared more than once in its file (an overload) is not a call target here
 * either. Picking between `put(String)` and `put(int)` needs the argument types, which is type
 * inference; greplost does not do it, so scoring it would measure a coin flip rather than a
 * map. Both sides drop the same class of call, and the leaf's report says so.
 */

import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import java.io.IOException;
import java.io.PrintStream;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.NestingKind;
import javax.lang.model.element.TypeElement;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Elements.Origin;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

public final class Truth {

  /** Source-root suffixes, in the order the design fixes them. */
  private static final String[] SOURCE_ROOTS = {"src/main/java", "src/test/java"};

  /** A JPMS module declaration, not a type: never compiled and never scored (see `run`). */
  private static final String MODULE_INFO = "module-info.java";

  private final Path root;
  private final Set<String> requested;
  private final Set<String> covered = new TreeSet<>();
  /**
   * Every requested file javac parsed, the broken ones included.
   *
   * The import *graph* is wider than the scored file set on purpose: greplost builds its
   * strongly connected components over every file it indexed and the harness then keeps the
   * cycles that sit entirely inside the scored universe. An oracle that ran Tarjan over the
   * covered files alone would split a cycle that passes through a dropped file into a smaller
   * one, and the two sides would disagree about a cycle neither of them got wrong.
   */
  private final Set<String> seen = new TreeSet<>();
  private final List<String> errors = new ArrayList<>();

  private Trees trees;
  private Elements elements;

  /** Element -> the repo-relative file declaring it; `""` when it has no source of ours. */
  private final Map<Element, String> fileByElement = new HashMap<>();
  /** file -> declaration name -> how many source declarations of that file carry it. */
  private final Map<String, Map<String, Integer>> declared = new HashMap<>();

  private Truth(Path root, Set<String> requested) {
    this.root = root;
    this.requested = requested;
  }

  public static void main(String[] args) throws Exception {
    String rootArg = null;
    String filesArg = null;
    for (int i = 0; i < args.length - 1; i++) {
      if ("--root".equals(args[i])) rootArg = args[i + 1];
      else if ("--files".equals(args[i])) filesArg = args[i + 1];
    }
    if (rootArg == null || filesArg == null) {
      System.err.println("usage: Truth --root <repo root> --files <file list>");
      System.exit(2);
      return;
    }
    Path root = Paths.get(rootArg).toAbsolutePath().normalize();
    try {
      root = root.toRealPath();
    } catch (IOException ignored) {
      // A root that cannot be canonicalised is still usable; relativisation just stays literal.
    }
    Set<String> requested = new LinkedHashSet<>();
    for (String line : Files.readAllLines(Paths.get(filesArg), StandardCharsets.UTF_8)) {
      String trimmed = line.trim();
      if (!trimmed.isEmpty()) requested.add(trimmed);
    }
    new Truth(root, requested).run();
  }

  private void run() throws IOException {
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) {
      System.err.println("Truth: no system Java compiler; run this on a JDK, not a JRE");
      System.exit(3);
      return;
    }

    List<Path> sources = new ArrayList<>();
    for (String rel : requested) {
      // `module-info.java` declares a JPMS module, not a type. A corpus that ships two of them
      // (one per Maven module) cannot be compiled as one task without `--module-source-path`,
      // and javac fails inside module resolution rather than reporting a diagnostic. The module
      // declarations carry no declaration, import or call this oracle scores, so they are left
      // out of the compilation and out of `files` — which drops them from scoring on both
      // sides, exactly as an unreadable file is dropped.
      if (rel.equals(MODULE_INFO) || rel.endsWith("/" + MODULE_INFO)) continue;
      Path path = root.resolve(rel);
      if (Files.isRegularFile(path)) sources.add(path);
    }
    if (sources.isEmpty()) {
      // javac throws on an empty file list; an empty truth document is the honest answer, and
      // the caller's integrity guard turns `"units": 0` into an error rather than four 1.000s.
      errors.add("no source file of the requested list exists under the root");
      print(new TreeMap<>(), new TreeSet<>(), new TreeSet<>(), 0);
      return;
    }

    DiagnosticCollector<JavaFileObject> collected = new DiagnosticCollector<>();
    StandardJavaFileManager manager = compiler.getStandardFileManager(collected, null, StandardCharsets.UTF_8);
    Iterable<? extends JavaFileObject> units = manager.getJavaFileObjectsFromPaths(sources);

    String classpath = String.join(java.io.File.pathSeparator, sourceRoots());
    List<String> options =
        List.of(
            "-proc:none",
            "-implicit:none",
            "-nowarn",
            "-Xmaxerrs",
            "100000",
            "-encoding",
            "UTF-8",
            "-classpath",
            classpath);

    Writer quiet = Writer.nullWriter();
    JavacTask task = (JavacTask) compiler.getTask(quiet, manager, collected, options, null, units);
    trees = Trees.instance(task);
    elements = task.getElements();

    List<CompilationUnitTree> parsed = new ArrayList<>();
    for (CompilationUnitTree unit : task.parse()) parsed.add(unit);
    try {
      task.analyze();
    } catch (RuntimeException | IOException failure) {
      // A crash inside javac is a fact about the corpus, not a reason to print an empty truth
      // set: the files that did type-check are still scored, and the failure is disclosed.
      errors.add("javac: " + failure);
    }

    Set<String> broken = new TreeSet<>();
    for (Diagnostic<? extends JavaFileObject> diagnostic : collected.getDiagnostics()) {
      if (diagnostic.getKind() != Diagnostic.Kind.ERROR) continue;
      JavaFileObject source = diagnostic.getSource();
      String file = source == null ? "" : relativize(source);
      if (file.isEmpty()) continue;
      broken.add(file);
    }
    for (String file : broken) errors.add(file);

    for (CompilationUnitTree unit : parsed) {
      String file = relativize(unit.getSourceFile());
      if (file.isEmpty() || !requested.contains(file)) continue;
      seen.add(file);
      if (!broken.contains(file)) covered.add(file);
    }

    Map<String, Set<String>> exports = new TreeMap<>();
    Set<String> imports = new TreeSet<>();
    Set<String> calls = new TreeSet<>();
    for (String file : covered) exports.put(file, new TreeSet<>());

    for (CompilationUnitTree unit : parsed) {
      String file = relativize(unit.getSourceFile());
      if (!covered.contains(file)) continue;
      indexDeclarations(unit, file);
    }
    for (CompilationUnitTree unit : parsed) {
      String file = relativize(unit.getSourceFile());
      if (!seen.contains(file)) continue;
      collectImports(unit, file, imports);
      if (!covered.contains(file)) continue;
      collectExports(unit, file, exports.get(file));
      collectCalls(unit, calls);
    }

    print(exports, imports, calls, parsed.size());
  }

  // -------------------------------------------------------------------------
  // the compilation environment
  // -------------------------------------------------------------------------

  /**
   * The corpus's own source roots, and nothing else: no jar, no local Maven repository. A file
   * whose dependency is a third-party jar therefore fails to resolve, lands in `errors`, and is
   * dropped — which is the point. An oracle that quietly resolved half a file would score
   * greplost against a truth set the compiler never actually saw.
   */
  private List<String> sourceRoots() {
    Set<String> roots = new LinkedHashSet<>();
    for (String suffix : SOURCE_ROOTS) {
      List<String> found = new ArrayList<>();
      for (String rel : requested) {
        int at = rel.startsWith(suffix + "/") ? 0 : rel.indexOf("/" + suffix + "/") + 1;
        if (at <= 0 && !rel.startsWith(suffix + "/")) continue;
        found.add(rel.substring(0, at + suffix.length()));
      }
      found.sort(Comparator.naturalOrder());
      roots.addAll(found);
    }
    roots.add("");
    List<String> out = new ArrayList<>();
    for (String rel : roots) out.add(rel.isEmpty() ? root.toString() : root.resolve(rel).toString());
    return out;
  }

  /** Repo-relative posix path of a source file, or `""` when it lives outside the root. */
  private String relativize(JavaFileObject file) {
    Path path;
    try {
      path = Paths.get(file.toUri()).toAbsolutePath().normalize();
    } catch (IllegalArgumentException | java.nio.file.FileSystemNotFoundException absent) {
      return "";
    }
    try {
      path = path.toRealPath();
    } catch (IOException ignored) {
      // Already normalised; a file that cannot be canonicalised is compared as written.
    }
    if (!path.startsWith(root)) return "";
    return root.relativize(path).toString().replace(java.io.File.separatorChar, '/');
  }

  // -------------------------------------------------------------------------
  // names
  // -------------------------------------------------------------------------

  /** Dotted name of a type inside its own file, or null for an anonymous or local one. */
  private String typeName(TypeElement type) {
    NestingKind nesting = type.getNestingKind();
    if (nesting == NestingKind.ANONYMOUS || nesting == NestingKind.LOCAL) return null;
    Element owner = type.getEnclosingElement();
    if (owner instanceof TypeElement outer) {
      String prefix = typeName(outer);
      return prefix == null ? null : prefix + "." + type.getSimpleName();
    }
    return type.getSimpleName().toString();
  }

  /** `<Type>.<member>` for a member of a named type, or null when there is no such name. */
  private String memberName(Element member) {
    if (!(member.getEnclosingElement() instanceof TypeElement owner)) return null;
    String prefix = typeName(owner);
    if (prefix == null) return null;
    return prefix + "." + simpleName(member, owner);
  }

  /** A constructor is named after its type; everything else is named after itself. */
  private String simpleName(Element member, TypeElement owner) {
    return member.getKind() == ElementKind.CONSTRUCTOR
        ? owner.getSimpleName().toString()
        : member.getSimpleName().toString();
  }

  /** True when a member was written in the source rather than synthesised by javac. */
  private boolean writtenInSource(Element member) {
    return elements.getOrigin(member) == Origin.EXPLICIT && trees.getTree(member) != null;
  }

  /** The repo-relative file an element was declared in, or `""` when it is not one of ours. */
  private String fileOf(Element element) {
    String cached = fileByElement.get(element);
    if (cached != null) return cached;
    TreePath path = trees.getPath(element);
    String file = path == null ? "" : relativize(path.getCompilationUnit().getSourceFile());
    fileByElement.put(element, file);
    return file;
  }

  // -------------------------------------------------------------------------
  // declarations, exports
  // -------------------------------------------------------------------------

  /** Every top-level type of one unit, as elements. */
  private List<TypeElement> topLevelTypes(CompilationUnitTree unit) {
    List<TypeElement> out = new ArrayList<>();
    TreePath unitPath = new TreePath(unit);
    for (Tree tree : unit.getTypeDecls()) {
      if (!(tree instanceof ClassTree)) continue;
      Element element = trees.getElement(new TreePath(unitPath, tree));
      if (element instanceof TypeElement type) out.add(type);
    }
    return out;
  }

  /** Count every source declaration name of one file, so an overload can be recognised. */
  private void indexDeclarations(CompilationUnitTree unit, String file) {
    Map<String, Integer> counts = declared.computeIfAbsent(file, key -> new HashMap<>());
    for (TypeElement type : topLevelTypes(unit)) countType(type, counts);
  }

  private void countType(TypeElement type, Map<String, Integer> counts) {
    String name = typeName(type);
    if (name == null) return;
    counts.merge(name, 1, Integer::sum);
    for (Element member : type.getEnclosedElements()) {
      if (member instanceof TypeElement nested) {
        countType(nested, counts);
        continue;
      }
      if (!writtenInSource(member)) continue;
      String memberName = memberName(member);
      if (memberName != null) counts.merge(memberName, 1, Integer::sum);
    }
  }

  /**
   * The public surface of one file: every public type whose enclosing chain is public, and
   * every public member those types declare themselves.
   *
   * `Elements.getAllMembers` is the compiler's own answer to "what does this type have", and it
   * includes everything inherited. A file's *exports* are what it declares, so a member whose
   * enclosing element is another type belongs to that other type's file, not to this one.
   */
  private void collectExports(CompilationUnitTree unit, String file, Set<String> out) {
    for (TypeElement type : topLevelTypes(unit)) exportType(type, file, out);
  }

  private void exportType(TypeElement type, String file, Set<String> out) {
    if (!type.getModifiers().contains(Modifier.PUBLIC)) return;
    String name = typeName(type);
    if (name == null) return;
    out.add(name);
    for (Element member : elements.getAllMembers(type)) {
      if (!type.equals(member.getEnclosingElement())) continue;
      if (member instanceof TypeElement) continue;
      if (!member.getModifiers().contains(Modifier.PUBLIC)) continue;
      if (!writtenInSource(member)) continue;
      String memberName = memberName(member);
      if (memberName != null) out.add(memberName);
    }
    for (Element member : type.getEnclosedElements()) {
      if (member instanceof TypeElement nested) exportType(nested, file, out);
    }
  }

  // -------------------------------------------------------------------------
  // imports
  // -------------------------------------------------------------------------

  private void collectImports(CompilationUnitTree unit, String file, Set<String> out) {
    for (ImportTree tree : unit.getImports()) {
      Tree identifier = tree.getQualifiedIdentifier();
      if (identifier == null) continue;
      String fqn = identifier.toString().replaceAll("\\s+", "");
      if (fqn.endsWith(".*")) continue;
      TypeElement type = null;
      for (String candidate = fqn; candidate.contains("."); ) {
        type = elements.getTypeElement(candidate);
        if (type != null) break;
        candidate = candidate.substring(0, candidate.lastIndexOf('.'));
      }
      if (type == null) continue;
      String target = fileOf(type);
      // A file importing a nested type of its own is not an edge; greplost's linker drops a
      // self-import for every language, so the oracle must not carry one either.
      if (target.isEmpty() || target.equals(file) || !seen.contains(target)) continue;
      out.add(file + " " + target);
    }
  }

  // -------------------------------------------------------------------------
  // calls
  // -------------------------------------------------------------------------

  private void collectCalls(CompilationUnitTree unit, Set<String> out) {
    TreePathScanner<Void, Void> scanner =
        new TreePathScanner<>() {
          @Override
          public Void visitMethodInvocation(MethodInvocationTree node, Void unused) {
            record(getCurrentPath(), out);
            return super.visitMethodInvocation(node, unused);
          }

          @Override
          public Void visitNewClass(NewClassTree node, Void unused) {
            // `RED, GREEN` in an enum body is a `new` the compiler wrote, not the author: it
            // would otherwise be an edge from the enum to itself that nobody can read in the
            // source and that greplost, reading only what is written, never emits.
            if (!isEnumConstant(getCurrentPath().getParentPath())) record(getCurrentPath(), out);
            return super.visitNewClass(node, unused);
          }
        };
    scanner.scan(new TreePath(unit), null);
  }

  /** True when this path is the declaration of an enum constant. */
  private boolean isEnumConstant(TreePath path) {
    if (path == null || !(path.getLeaf() instanceof VariableTree)) return false;
    Element element = trees.getElement(path);
    return element != null && element.getKind() == ElementKind.ENUM_CONSTANT;
  }

  private void record(TreePath path, Set<String> out) {
    Element target = trees.getElement(path);
    if (!(target instanceof ExecutableElement callee)) return;
    String targetFile = fileOf(target);
    if (!covered.contains(targetFile)) return;
    if (!(callee.getEnclosingElement() instanceof TypeElement owner)) return;
    String ownerName = typeName(owner);
    if (ownerName == null) return;

    String to;
    if (!writtenInSource(callee)) {
      // A generated constructor is not a declaration, so a `new` of that type points at the
      // type itself; any other generated member (a record accessor, an enum's `values`) has
      // nothing to point at and the call is not truth.
      if (callee.getKind() != ElementKind.CONSTRUCTOR) return;
      to = ownerName;
    } else {
      to = ownerName + "." + simpleName(callee, owner);
    }
    if (count(targetFile, to) != 1) return;

    String from = callerOf(path);
    if (from == null) return;
    out.add(from + " " + targetFile + "#" + to);
  }

  private int count(String file, String name) {
    Map<String, Integer> counts = declared.get(file);
    if (counts == null) return 0;
    Integer found = counts.get(name);
    return found == null ? 0 : found;
  }

  /**
   * The declaration one call belongs to: the nearest enclosing method with a name, else the
   * nearest enclosing type with one.
   *
   * A method of an anonymous or local class has no dotted name, so the walk carries on past it
   * to the method that contains it — which is where a reader would look for the call, and
   * where greplost attributes it too.
   */
  private String callerOf(TreePath path) {
    for (TreePath current = path.getParentPath(); current != null; current = current.getParentPath()) {
      Tree leaf = current.getLeaf();
      if (!(leaf instanceof MethodTree) && !(leaf instanceof ClassTree)) continue;
      Element element = trees.getElement(current);
      if (element == null) continue;
      String file = fileOf(element);
      if (!covered.contains(file)) continue;
      String name = leaf instanceof MethodTree ? memberName(element) : typeName((TypeElement) element);
      if (name == null) continue;
      return file + "#" + name;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // output
  // -------------------------------------------------------------------------

  private void print(Map<String, Set<String>> exports, Set<String> imports, Set<String> calls, int units) {
    StringBuilder out = new StringBuilder(1 << 16);
    out.append("{\"files\":");
    appendStrings(out, covered);
    out.append(",\"imports\":");
    appendEdges(out, imports);
    out.append(",\"exports\":{");
    boolean first = true;
    for (Map.Entry<String, Set<String>> entry : exports.entrySet()) {
      if (!first) out.append(',');
      first = false;
      appendString(out, entry.getKey());
      out.append(':');
      appendStrings(out, entry.getValue());
    }
    out.append("},\"calls\":");
    appendEdges(out, calls);
    out.append(",\"errors\":");
    appendStrings(out, new TreeSet<>(new HashSet<>(errors)));
    out.append(",\"units\":").append(units).append('}');
    PrintStream stdout = new PrintStream(System.out, false, StandardCharsets.UTF_8);
    stdout.print(out);
    stdout.flush();
  }

  private static void appendEdges(StringBuilder out, Set<String> edges) {
    out.append('[');
    boolean first = true;
    for (String edge : edges) {
      int at = edge.indexOf(' ');
      if (at < 0) continue;
      if (!first) out.append(',');
      first = false;
      out.append("{\"from\":");
      appendString(out, edge.substring(0, at));
      out.append(",\"to\":");
      appendString(out, edge.substring(at + 1));
      out.append('}');
    }
    out.append(']');
  }

  private static void appendStrings(StringBuilder out, Iterable<String> values) {
    out.append('[');
    boolean first = true;
    for (String value : values) {
      if (!first) out.append(',');
      first = false;
      appendString(out, value);
    }
    out.append(']');
  }

  private static void appendString(StringBuilder out, String value) {
    out.append('"');
    for (int i = 0; i < value.length(); i++) {
      char ch = value.charAt(i);
      switch (ch) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> {
          if (ch < 0x20) out.append(String.format("\\u%04x", (int) ch));
          else out.append(ch);
        }
      }
    }
    out.append('"');
  }
}
