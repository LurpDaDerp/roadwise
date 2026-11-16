package expo.modules.drivesense

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface

/**
 * The drive notification's large icon: the posted limit in the driving screen's sign style for the
 * unit, as the Live Activity's lock screen draws it — the US SPEED LIMIT plate for mph, the round
 * red-ringed sign for km/h, "-" when unknown — on a transparent square the size of a notification's
 * large icon ([LimitSignGeometry] holds the layout). Numbers in tabular figures (the widget's
 * `monospacedDigit`), the plate's number in the heaviest sans weight, the legend and the round sign's
 * number bold.
 *
 * Drawn once per limit, unit and size and kept ([CACHE_SIZE] signs): a drive's notification updates
 * every few seconds but its limit changes only now and then. Thread-safe.
 */
object LimitSignBitmap {
  private const val CACHE_SIZE = 4

  private val cache = object : LinkedHashMap<String, Bitmap>(CACHE_SIZE, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Bitmap>?): Boolean = size > CACHE_SIZE
  }

  /** The sign for [limitText] ("35" or "-") in [unit], or null if it cannot be drawn (no memory). */
  @Synchronized
  fun of(context: Context, limitText: String, unit: String): Bitmap? {
    val res = context.resources
    val size = runCatching { res.getDimensionPixelSize(android.R.dimen.notification_large_icon_height) }
      .getOrNull()
      ?.takeIf { it > 0 }
      ?: Math.round(64 * res.displayMetrics.density)
    val key = "$unit|$limitText|$size"
    cache[key]?.let { return it }
    val bitmap = try {
      draw(limitText, unit, size, res.displayMetrics.density)
    } catch (_: Throwable) {
      // OutOfMemoryError or a canvas failure: the notification goes without its sign.
      return null
    }
    cache[key] = bitmap
    return bitmap
  }

  private fun draw(limitText: String, unit: String, size: Int, density: Float): Bitmap {
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    if (unit == "km/h") roundSign(canvas, limitText, size.toFloat(), density) else usPlate(canvas, limitText, size.toFloat(), density)
    return bitmap
  }

  private fun usPlate(canvas: Canvas, limitText: String, size: Float, density: Float) {
    val g = LimitSignGeometry.plate(size, density)
    val left = (size - g.width) / 2f
    val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.FILL }
    canvas.drawRoundRect(RectF(left, 0f, left + g.width, g.height), g.corner, g.corner, fill)
    // The border lies wholly inside its inset rectangle (SwiftUI's strokeBorder): a stroke centred
    // half its width further in.
    val half = g.line / 2f
    val border = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.BLACK
      style = Paint.Style.STROKE
      strokeWidth = g.line
    }
    val r = maxOf(0f, g.corner - g.inset - half)
    canvas.drawRoundRect(
      RectF(left + g.inset + half, g.inset + half, left + g.width - g.inset - half, g.height - g.inset - half),
      r,
      r,
      border
    )
    val cx = left + g.width / 2f
    if (g.showsLegend) {
      val legend = textPaint(Typeface.DEFAULT_BOLD, g.legendSize)
      line(canvas, "SPEED", legend, cx, g.speedY, g.textWidth, LimitSignGeometry.MIN_SCALE_PLATE)
      line(canvas, "LIMIT", legend, cx, g.limitY, g.textWidth, LimitSignGeometry.MIN_SCALE_PLATE)
    }
    val numeral = textPaint(Typeface.create("sans-serif-black", Typeface.NORMAL), g.numeralSize)
    line(canvas, limitText, numeral, cx, g.numeralY, g.textWidth, LimitSignGeometry.MIN_SCALE_PLATE)
  }

  private fun roundSign(canvas: Canvas, limitText: String, size: Float, density: Float) {
    val g = LimitSignGeometry.round(size, density)
    val c = size / 2f
    val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.FILL }
    canvas.drawCircle(c, c, g.diameter / 2f, fill)
    val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = LimitSignGeometry.SIGN_RED
      style = Paint.Style.STROKE
      strokeWidth = g.ring
    }
    canvas.drawCircle(c, c, g.diameter / 2f - g.ring / 2f, ring)
    val numeral = textPaint(Typeface.DEFAULT_BOLD, g.numeralSize)
    line(canvas, limitText, numeral, c, c, g.textWidth, LimitSignGeometry.MIN_SCALE_ROUND)
  }

  private fun textPaint(face: Typeface, size: Float): Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.BLACK
    typeface = face
    textSize = size
    textAlign = Paint.Align.CENTER
    fontFeatureSettings = "tnum"
  }

  /** One line centred on ([cx], [cy]) by its glyphs' own box, shrunk to [maxWidth] first (never below [minScale]). */
  private fun line(canvas: Canvas, text: String, paint: Paint, cx: Float, cy: Float, maxWidth: Float, minScale: Float) {
    paint.textSize = LimitSignGeometry.fitted(paint.textSize, paint.measureText(text), maxWidth, minScale)
    val bounds = Rect()
    paint.getTextBounds(text, 0, text.length, bounds)
    canvas.drawText(text, cx, cy - (bounds.top + bounds.bottom) / 2f, paint)
  }
}
