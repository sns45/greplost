package tiny

/** A stored item. A `data class` is a `record`, and its constructor `val`s are properties. */
data class Item(val id: String, val size: Int)

/** An interface's members are public without saying so. */
interface Sink {
    fun accept(item: Item): Boolean
}

/** A `fun interface` is a SAM type: the grammar this repo pins is the one that reads it. */
fun interface Handler {
    fun handle(item: Item): Boolean
}

/** An `object` is a class with `meta.object = "1"`; its members are methods. */
object Store : Sink {
    private var total: Int = 0

    override fun accept(item: Item): Boolean {
        total += 1
        return true
    }

    /** A suspend function: `meta.suspend = "1"`, and `this.accept` resolves inside the object. */
    suspend fun put(item: Item): Boolean = this.accept(item)
}

/** A holder whose companion object owns the factory, so its members take `Box.Companion`. */
class Box(val item: Item) {
    companion object {
        fun of(item: Item): Box = Box(item)
    }
}

/** An extension function on an indexed type: named `Item.label`, with `Item` as its parent. */
fun Item.label(): String = this.id
