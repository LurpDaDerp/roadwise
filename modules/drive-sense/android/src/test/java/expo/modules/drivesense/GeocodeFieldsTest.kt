package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android geocoder's answer in expo-location's address shape, and the district rule that keeps a
 * label from dropping to the street when Google gives no sub-locality (Geocode.kt, WP10). Pure JVM.
 */
class GeocodeFieldsTest {
  private fun fields(
    featureName: String? = null,
    subThoroughfare: String? = null,
    thoroughfare: String? = null,
    subLocality: String? = null,
    locality: String? = "Seattle",
    subAdminArea: String? = "King County",
    adminArea: String? = "Washington",
    postalCode: String? = "98103",
    countryName: String? = "United States",
    countryCode: String? = "US"
  ) = GeocodeFields(featureName, subThoroughfare, thoroughfare, subLocality, locality, subAdminArea, adminArea, postalCode, countryName, countryCode)

  @Test
  fun `the record carries expo-location's keys in its order, blanks as null`() {
    val r = fields(featureName = "1200", subThoroughfare = "1200", thoroughfare = "Dexter Ave N", subLocality = "  ").toRecord()
    assertEquals(
      listOf("city", "district", "streetNumber", "street", "region", "subregion", "country", "postalCode", "name", "isoCountryCode"),
      r.keys.toList()
    )
    assertEquals("Seattle", r["city"])
    assertNull(r["district"])
    assertEquals("1200", r["streetNumber"])
    assertEquals("Dexter Ave N", r["street"])
    assertEquals("Washington", r["region"])
    assertEquals("King County", r["subregion"])
    assertEquals("United States", r["country"])
    assertEquals("98103", r["postalCode"])
    assertEquals("1200", r["name"])
    assertEquals("US", r["isoCountryCode"])
  }

  @Test
  fun `the sub-locality is the district when there is one`() {
    assertEquals("Fremont", fields(subLocality = " Fremont ", featureName = "Wallingford").district())
  }

  @Test
  fun `a feature name that reads like a neighbourhood stands in for a missing sub-locality`() {
    assertEquals("Wallingford", fields(featureName = "Wallingford", thoroughfare = "N 45th St").district())
  }

  @Test
  fun `house numbers, postcodes, plus codes and address lines are never a district`() {
    for (name in listOf("1200", "98103", "CWC8+R9", "1200 Dexter Ave N", "Dexter Ave N, Seattle", "12B", "  ", "+-")) {
      assertNull(name, fields(featureName = name).district())
    }
  }

  @Test
  fun `the street, city, county, state or country named again is never a district`() {
    for (name in listOf("Dexter Ave N", "seattle", "King County", "Washington", "United States")) {
      assertNull(name, fields(featureName = name, thoroughfare = "Dexter Ave N").district())
    }
  }

  @Test
  fun `nothing to go on is no district`() {
    assertNull(fields().district())
  }

  @Test
  fun `a lookup answers once, the first of the geocoder and the timeout wins`() {
    val answers = mutableListOf<List<Map<String, Any?>>?>()
    val once = Geocode.Once { answers.add(it) }
    assertFalse(once.settled)
    once.answer(null)
    once.answer(listOf(mapOf("city" to "Seattle")))
    assertTrue(once.settled)
    assertEquals(listOf<List<Map<String, Any?>>?>(null), answers)
  }

  @Test
  fun `a queued lookup whose timeout passed while it waited never calls the geocoder`() {
    val answers = mutableListOf<List<Map<String, Any?>>?>()
    val once = Geocode.Once { answers.add(it) }
    once.answer(null) // the timeout
    var called = false
    Geocode.runQueued(once) {
      called = true
      listOf(mapOf("city" to "Seattle"))
    }
    assertFalse(called)
    assertEquals(1, answers.size)
  }

  @Test
  fun `a queued lookup still waiting runs, and a failure answers null`() {
    val got = mutableListOf<List<Map<String, Any?>>?>()
    Geocode.runQueued(Geocode.Once { got.add(it) }) { listOf(mapOf("city" to "Seattle")) }
    Geocode.runQueued(Geocode.Once { got.add(it) }) { throw java.io.IOException("backend busy") }
    assertEquals(listOf(listOf(mapOf("city" to "Seattle")), null), got)
  }
}
