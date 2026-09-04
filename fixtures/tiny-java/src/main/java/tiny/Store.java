package tiny;

import java.util.ArrayList;
import java.util.List;

/** A tiny in-memory store: a public class with a nested public record. */
@Tag("store")
public class Store implements Marker {
  /** How many values one store keeps. */
  public static final int LIMIT = 8;

  private final List<String> values = new ArrayList<>();
  private final String label;

  /** Builds a store under a label. */
  public Store(String label) {
    this.label = label;
  }

  @Override
  public String name() {
    return this.label;
  }

  /** Puts one value, through the private recorder. */
  public void put(String value) {
    this.record(value);
  }

  private void record(String value) {
    values.add(value);
  }

  /** One stored pair; its accessors are generated, not written. */
  public record Entry(String key, String value) {}
}
