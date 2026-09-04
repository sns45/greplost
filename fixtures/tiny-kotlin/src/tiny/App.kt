@file:JvmName("AppMain")

package tiny

import tiny.util.retry

/** One same-package call, one companion call, one extension call and one imported call. */
suspend fun main() {
    val item: Item = Item("a", 1)
    Store.put(item)
    Box.of(item)
    item.label()
    retry(2)
}
