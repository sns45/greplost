@file:JvmName("AppMain")

package tiny

import tiny.util.retry
import tiny.util.retry as again
import tiny.util.shout
import tiny.util.*

/**
 * One same-package call, one companion call, one extension call on a local, one on a string
 * literal, one imported call and one through an import alias.
 */
suspend fun main() {
    val item: Item = Item("a", 1)
    val handler = Handler { true }
    Store.put(item)
    Box.of(item)
    item.label()
    "kt".shout()
    retry(2)
    again(3)
}
