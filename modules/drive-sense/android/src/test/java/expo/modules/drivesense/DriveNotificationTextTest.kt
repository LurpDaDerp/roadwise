package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The drive notification's words and its parsing (ruling 6: the Live Activity's content, rules and
 * VoiceOver words). Pure JVM.
 */
class DriveNotificationTextTest {
  private fun display(
    speed: Double? = 34.4,
    limit: Double? = 35.0,
    unit: String = "mph",
    tint: String? = null,
    speeding: Boolean = false,
    hint: Boolean = false,
    kind: String? = null,
    text: String? = null
  ) = DriveDisplay(
    speed = speed,
    limit = limit,
    unit = unit,
    speedTint = tint,
    speeding = speeding,
    notDrivingAvailable = hint,
    weatherKind = kind,
    weatherText = text
  )

  @Test
  fun `the title is the speed and its unit, "-" until the first fix, the tint covers the number only`() {
    assertEquals("34 mph", DriveNotificationText.title(display()))
    assertEquals("35 mph", DriveNotificationText.title(display(speed = 34.5)))
    assertEquals("- mph", DriveNotificationText.title(display(speed = null)))
    assertEquals("102 km/h", DriveNotificationText.title(display(speed = 101.6, unit = "km/h")))
    assertEquals(0 until 2, DriveNotificationText.speedRange(display()))
    assertEquals(0 until 1, DriveNotificationText.speedRange(display(speed = null)))
  }

  @Test
  fun `the text - the limit, then the weather line and "Not driving?" while they show`() {
    assertEquals("Limit 35", DriveNotificationText.text(display()))
    assertEquals("Limit -", DriveNotificationText.text(display(limit = null)))
    assertNull(DriveNotificationText.bigText(display()))
    val full = display(hint = true, kind = "heavy_rain", text = "Heavy rain")
    assertEquals("Limit 35 · 🌧️ Heavy rain · Not driving?", DriveNotificationText.text(full))
    assertEquals("Limit 35\n🌧️ Heavy rain\nNot driving?", DriveNotificationText.bigText(full))
    assertEquals("Limit 35\nNot driving?", DriveNotificationText.bigText(display(hint = true)))
  }

  @Test
  fun `every danger kind has its symbol, an unknown kind gets the warning sign`() {
    val kinds = listOf(
      "blizzard", "freezing_rain", "black_ice", "freezing_drizzle", "hail", "high_wind", "heavy_snow", "snow_on_road",
      "freezing_fog", "dense_fog", "low_visibility", "thunderstorm", "heavy_rain", "standing_water", "strong_wind", "rain_at_night"
    )
    for (k in kinds) assertNotEquals(k, WeatherSymbol.WARNING, WeatherSymbol.of(k))
    assertEquals(WeatherSymbol.WARNING, WeatherSymbol.of("volcano"))
    assertEquals("⛈️", WeatherSymbol.of("thunderstorm"))
  }

  @Test
  fun `the chip is "34 mph", or the number alone past 7 characters`() {
    assertEquals("34 mph", DriveNotificationText.chip(display()))
    assertEquals("34 km/h", DriveNotificationText.chip(display(unit = "km/h")))
    assertEquals("120", DriveNotificationText.chip(display(speed = 120.0, unit = "km/h")))
    assertEquals("- mph", DriveNotificationText.chip(display(speed = null)))
  }

  @Test
  fun `TalkBack reads VoiceOver's words`() {
    assertEquals("Speed 34 miles per hour. Speed limit 35", DriveNotificationText.accessibility(display()))
    assertEquals(
      "Speed 60 kilometers per hour, over the limit. Speed limit 50. Heavy rain. Not driving?",
      DriveNotificationText.accessibility(display(speed = 60.0, limit = 50.0, unit = "km/h", speeding = true, hint = true, kind = "heavy_rain", text = "Heavy rain"))
    )
    assertEquals("Speed unknown. Speed limit unknown", DriveNotificationText.accessibility(display(speed = null, limit = null)))
  }

  @Test
  fun `stale - no speed, tint, hint or weather, the limit, unit and sky stay`() {
    val live = display(tint = "#FF0000", speeding = true, hint = true, kind = "hail", text = "Hail").copy(skyMid = "#102030", accent = "#FFC300")
    val s = live.stale()
    assertNull(s.speed)
    assertNull(s.speedTint)
    assertFalse(s.speeding)
    assertFalse(s.notDrivingAvailable)
    assertNull(s.weatherKind)
    assertNull(s.weatherText)
    assertEquals(35.0, s.limit!!, 0.0)
    assertEquals("mph", s.unit)
    assertEquals("#102030", s.skyMid)
    assertEquals("- mph", DriveNotificationText.title(s))
    assertEquals("Limit 35", DriveNotificationText.text(s))
    assertEquals(120_000L, DriveNotificationText.STALE_AFTER_MS)
  }

  @Test
  fun `the content key changes with what shows and only with it`() {
    val a = display()
    assertEquals(DriveNotificationText.key(a, false), DriveNotificationText.key(a.copy(skyTop = "#000000"), false))
    assertEquals(DriveNotificationText.key(a, false), DriveNotificationText.key(a.copy(speed = 34.2), false))
    assertNotEquals(DriveNotificationText.key(a, false), DriveNotificationText.key(a.copy(speed = 35.0), false))
    assertNotEquals(DriveNotificationText.key(a, false), DriveNotificationText.key(a, true))
    assertNotEquals(DriveNotificationText.key(a, false), DriveNotificationText.key(a.copy(speedTint = "#FF0000"), false))
    assertNotEquals(DriveNotificationText.key(a, false), DriveNotificationText.key(a.copy(notDrivingAvailable = true), false))
    assertNotEquals(DriveNotificationText.key(a, false), DriveNotificationText.key(a.copy(limit = 40.0), false))
    assertNotEquals(DriveNotificationText.key(a, false), DriveNotificationText.key(a.copy(unit = "km/h"), false))
    assertNotEquals(DriveNotificationText.key(a, false), DriveNotificationText.key(a.copy(skyMid = "#000000"), false))
    assertNotEquals(DriveNotificationText.key(a, false), DriveNotificationText.key(a.copy(accent = "#000000"), false))
    assertNotEquals(DriveNotificationText.key(a, false), DriveNotificationText.key(a.stale(), false))
  }

  @Test
  fun `parsing keeps only what the Live Activity's schema takes`() {
    val d = DriveDisplay.from(
      mapOf(
        "speed" to 34, "limit" to Double.NaN, "unit" to "km/h", "points" to 1240, "stopped" to true,
        "speedTint" to "#ff0000", "speeding" to true, "notDrivingAvailable" to true,
        "weatherKind" to "heavy_rain", "weatherText" to "Heavy rain", "skyMid" to "navy", "accent" to "#FFC300"
      )
    )
    assertEquals(34.0, d.speed!!, 0.0)
    assertNull(d.limit)
    assertEquals("km/h", d.unit)
    assertEquals("#ff0000", d.speedTint)
    assertTrue(d.speeding)
    assertTrue(d.notDrivingAvailable)
    assertEquals("heavy_rain", d.weatherKind)
    assertEquals("Heavy rain", d.weatherText)
    assertNull(d.skyMid)
    assertEquals("#FFC300", d.accent)
    assertFalse(d.ended)
    // A weather line is its symbol and its words: half of one is none.
    val half = DriveDisplay.from(mapOf("unit" to "mph", "weatherKind" to "Heavy Rain!", "weatherText" to "Heavy rain"))
    assertNull(half.weatherKind)
    assertNull(half.weatherText)
    val long = DriveDisplay.from(mapOf("unit" to "mph", "weatherKind" to "hail", "weatherText" to "x".repeat(61)))
    assertNull(long.weatherKind)
    assertNull(DriveDisplay.from(mapOf("unit" to "mph", "weatherKind" to "hail", "weatherText" to "")).weatherText)
    assertEquals("mph", DriveDisplay.from(mapOf("unit" to "knots")).unit)
    assertTrue(DriveDisplay.from(mapOf("unit" to "mph", "ended" to true)).ended)
  }

  @Test
  fun `Live Updates start at API 36_1 as SDK_INT_FULL writes it`() {
    assertEquals(3_600_001, LiveUpdates.SDK_INT_FULL_36_1)
  }
}
