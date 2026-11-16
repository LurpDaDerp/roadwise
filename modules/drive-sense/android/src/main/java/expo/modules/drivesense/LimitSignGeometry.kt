package expo.modules.drivesense

/**
 * Where everything on the drive notification's speed-limit sign goes (pure: the JVM tests hold it),
 * the Live Activity's `LimitSign` (targets/live-drive-widget/LiveDriveWidgetBundle.swift) in
 * pixels: every proportion is the widget's, and every fixed length there in points is here in dp
 * ([density] pixels each). [LimitSignBitmap] draws it.
 *
 * The US R2-1 plate (mph): 0.8 as wide as tall; white with rounded corners (0.06 of its width), a
 * black border max(1.5 dp, 0.025 of the width) wide inset 2 dp; "SPEED" / "LIMIT" at 0.167 of the
 * height (only when the plate is 30 dp tall or more) and the number at 0.46. Each line sits by its
 * centre inside the border's inner edge: the legend's two lines 1.4 capitals apart, and the room
 * left split evenly over the top, the gap above the number and the bottom. Every line keeps 2.5 dp
 * clear of the border at the sides and shrinks (to half) first.
 *
 * The round sign (km/h): a white disc with a red (#D7263D) ring max(2 dp, 0.09 of the height) wide
 * inside its edge, the number at 0.42 of the height held to 0.8 of the ring's inside (shrinking to
 * 0.6 first).
 */
object LimitSignGeometry {
  /** A capital or a digit stands this much of the point size (the widget's `LimitSign.cap`). */
  const val CAP = 0.705f

  /** The ring's red, #D7263D. */
  const val SIGN_RED = 0xFFD7263D.toInt()

  data class Plate(
    val width: Float,
    val height: Float,
    val corner: Float,
    /** The border's width, and its inset from the plate's edge. */
    val line: Float,
    val inset: Float,
    val legendSize: Float,
    val numeralSize: Float,
    val showsLegend: Boolean,
    /** The centres of "SPEED", "LIMIT" and the number, from the plate's top. */
    val speedY: Float,
    val limitY: Float,
    val numeralY: Float,
    /** The widest a line may run; [MIN_SCALE_PLATE] the smallest it shrinks to. */
    val textWidth: Float
  )

  data class Round(
    val diameter: Float,
    val ring: Float,
    val numeralSize: Float,
    val textWidth: Float
  )

  const val MIN_SCALE_PLATE = 0.5f
  const val MIN_SCALE_ROUND = 0.6f

  fun plate(height: Float, density: Float): Plate {
    val w = height * 0.8f
    val line = maxOf(1.5f * density, w * 0.025f)
    val edge = 2f * density + line
    val legend = height * 0.167f
    val numeral = height * 0.46f
    val showsLegend = height >= 30f * density
    val capL = legend * CAP
    val capN = numeral * CAP
    val legendSpan = if (showsLegend) 2.4f * capL else 0f
    val room = height - 2f * edge - legendSpan - capN
    val gap = room / (if (showsLegend) 3f else 2f)
    val speedY = edge + gap + capL / 2f
    return Plate(
      width = w,
      height = height,
      corner = w * 0.06f,
      line = line,
      inset = 2f * density,
      legendSize = legend,
      numeralSize = numeral,
      showsLegend = showsLegend,
      speedY = speedY,
      limitY = speedY + 1.4f * capL,
      numeralY = height - edge - gap - capN / 2f,
      textWidth = w - 2f * (edge + 2.5f * density)
    )
  }

  fun round(height: Float, density: Float): Round {
    val ring = maxOf(2f * density, height * 0.09f)
    return Round(
      diameter = height,
      ring = ring,
      numeralSize = height * 0.42f,
      textWidth = (height - 2f * ring) * 0.8f
    )
  }

  /** The size a line is drawn at: [size], shrunk to fit [maxWidth] (its width at [size] being [measured]), never below [minScale] of it. */
  fun fitted(size: Float, measured: Float, maxWidth: Float, minScale: Float): Float {
    if (measured <= maxWidth || measured <= 0f) return size
    return size * maxOf(minScale, maxWidth / measured)
  }
}
