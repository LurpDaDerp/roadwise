package expo.modules.drivesense

/**
 * The symbol on the drive notification's weather line for each dangerous-weather kind the driving
 * screen can show (`DANGER_ORDER` in src/features/weather/danger.ts; the native-android suite checks
 * every id has its case), the Live Activity's `WeatherSymbol.swift` drawn the Android way. A
 * notification's text crosses to the system UI as parcelled text, which keeps colour and style spans
 * but drops image spans, so the symbol is a weather emoji (the system's colour emoji font draws it
 * on every Android version RoadWise runs on), picked to say what the iPhone's SF Symbol says: snow
 * and sleet a cloud with snow, ice a snowflake, wind a wind face, fog and low visibility fog, a
 * thunderstorm a cloud with lightning and rain, rain a cloud with rain, standing water a droplet. An
 * unknown kind gets the warning sign, as on the iPhone.
 */
object WeatherSymbol {
  private const val CLOUD_SNOW = "🌨️" // U+1F328 cloud with snow
  private const val SNOWFLAKE = "❄️" // U+2744 snowflake
  private const val WIND = "🌬️" // U+1F32C wind face
  private const val FOG = "🌫️" // U+1F32B fog
  private const val STORM = "⛈️" // U+26C8 cloud with lightning and rain
  private const val RAIN = "🌧️" // U+1F327 cloud with rain
  private const val DROPLET = "💧" // U+1F4A7 droplet
  const val WARNING = "⚠️" // U+26A0 warning sign

  fun of(kind: String): String = when (kind) {
    "blizzard" -> CLOUD_SNOW
    "freezing_rain" -> CLOUD_SNOW
    "black_ice" -> SNOWFLAKE
    "freezing_drizzle" -> CLOUD_SNOW
    "hail" -> CLOUD_SNOW
    "high_wind" -> WIND
    "heavy_snow" -> CLOUD_SNOW
    "snow_on_road" -> CLOUD_SNOW
    "freezing_fog" -> FOG
    "dense_fog" -> FOG
    "low_visibility" -> FOG
    "thunderstorm" -> STORM
    "heavy_rain" -> RAIN
    "standing_water" -> DROPLET
    "strong_wind" -> WIND
    "rain_at_night" -> RAIN
    else -> WARNING
  }
}
