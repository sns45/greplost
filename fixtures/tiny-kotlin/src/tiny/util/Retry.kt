package tiny.util

/** A top-level suspend function, imported by name from another package. */
suspend fun retry(attempts: Int): Int = attempts + LIMIT

/** An extension function on a type this repo does not own: named `String.shout`. */
fun String.shout(): String = this.uppercase()

/** `val` is a `const`, and `private` is what makes it unexported. */
private const val LIMIT: Int = 3

/** `var` is a `var`. */
private var seed: Int = 1

/** A `type_alias` is a `type`. */
private typealias Attempts = Int
