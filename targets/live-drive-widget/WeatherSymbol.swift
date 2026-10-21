// The SF Symbol for each dangerous-weather kind the driving screen can show (`DANGER_ORDER` in
// src/features/weather/danger.ts; modules/live-drive/__tests__ checks every id has its case). Each
// symbol exists on iOS 16. An unknown kind gets the warning triangle.
import Foundation

enum WeatherSymbol {
  static func name(_ kind: String) -> String {
    switch kind {
    case "blizzard": return "wind.snow"
    case "freezing_rain": return "cloud.sleet"
    case "black_ice": return "snowflake"
    case "freezing_drizzle": return "cloud.sleet"
    case "hail": return "cloud.hail"
    case "high_wind": return "wind"
    case "heavy_snow": return "cloud.snow"
    case "snow_on_road": return "cloud.snow"
    case "freezing_fog": return "cloud.fog"
    case "dense_fog": return "cloud.fog"
    case "low_visibility": return "eye.slash"
    case "thunderstorm": return "cloud.bolt.rain"
    case "heavy_rain": return "cloud.heavyrain"
    case "standing_water": return "drop"
    case "strong_wind": return "wind"
    case "rain_at_night": return "cloud.moon.rain"
    default: return "exclamationmark.triangle"
    }
  }
}
