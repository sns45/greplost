package tiny;

/** Every store names itself. An interface member is implicitly public. */
public interface Marker {
  /** The label this marker carries. */
  String name();
}

/**
 * A package-private annotation type, so this file stays legal Java: only one top-level type
 * per file may be public. It exercises `annotation_type_declaration` and, being
 * package-private, the rule that a non-public type exports nothing.
 */
@interface Tag {
  /** The tag text. */
  String value();
}
