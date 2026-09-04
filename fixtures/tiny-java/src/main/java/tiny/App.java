package tiny;

import static tiny.Retry.attempts;

import tiny.Store;

/** The entry point. */
@Tag("app")
@Deprecated
public class App {
  private final Store store;

  /** Builds an app around a fresh store. */
  public App() {
    this.store = new Store("app");
  }

  /** Runs one pass over a local store. */
  public void run() {
    Store local = new Store("run");
    local.put("x");
    this.warm();
    int n = attempts();
    Retry.warm(local);
  }

  private void warm() {
    Retry.warm(this.store);
  }

  /** Colours an app can be in. */
  public enum Colour {
    RED,
    GREEN
  }
}
