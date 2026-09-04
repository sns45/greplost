package tiny;

/**
 * Retry helpers. `Store` is used here with **no import at all**: it is a sibling of this file
 * in the same package, which is the one Java resolution rule that has no import statement
 * behind it.
 */
public final class Retry {
  /** Default attempt count. */
  public static final int ATTEMPTS = 3;

  private Retry() {}

  /** How many attempts a caller gets. */
  public static int attempts() {
    return ATTEMPTS;
  }

  /** Fills a store, retrying up to `attempts()` times. */
  public static void warm(Store store) {
    for (int i = 0; i < attempts(); i++) {
      store.put("warm");
    }
  }
}
