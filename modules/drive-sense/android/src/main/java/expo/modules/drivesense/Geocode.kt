package expo.modules.drivesense

import android.content.Context
import android.location.Address
import android.location.Geocoder
import android.os.Build
import androidx.annotation.RequiresApi
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The phone's own geocoder for the drive labels, the spots' street names, a saved place's Look up
 * and Permit mode's state (WP10). expo-location's geocoder pauses itself whenever RoadWise's
 * activity goes behind (it throws "Geocoder is not running"), so a drive Android finalizes with the
 * app in the background or headless lost its from/to labels. [android.location.Geocoder] needs no
 * activity and no permission, so this one answers the same in front, behind and headless.
 *
 * - API 33+: the asynchronous [Geocoder.GeocodeListener] form (no thread of ours blocks on the
 *   network). Below 33: the old blocking call, on one background thread of this object.
 * - Every lookup answers once, within [TIMEOUT_MS]: a late answer is dropped. JS gives up on a drive
 *   label at 4 s ([labels.ts] GEOCODE_TIMEOUT_MS); this cap only keeps a stuck backend from holding
 *   a promise open for good.
 * - [Geocoder.isPresent] false (a phone without Google's geocoding backend, some AOSP and Huawei
 *   builds) answers null: no label, as ruling 17 accepts. No other geocoder is asked.
 * - Answers carry expo-location's address shape (`ReverseGeocodeResponse`) so the JS callers read
 *   both platforms the same way, with one Android difference: `district` falls back to the
 *   feature's name when Google gives no sub-locality and that name reads like a neighbourhood
 *   ([GeocodeFields.district]), so a label reads "Fremont" where the sub-locality is empty rather
 *   than dropping to the street at once.
 *
 * One coordinate (or the typed address) goes to the OS geocoder and nothing else; nothing is logged.
 */
internal object Geocode {
  /** The longest a lookup may take natively before it answers null. */
  const val TIMEOUT_MS = 5_000L

  /** As many answers as expo-location asks for: the first is the one every caller reads. */
  private const val MAX_RESULTS = 1

  /** The longest typed address forwarded (the Look up field's text). */
  const val MAX_QUERY_CHARS = 200

  private val worker: ExecutorService by lazy {
    Executors.newSingleThreadExecutor { r -> Thread(r, "DriveSenseGeocode").apply { isDaemon = true } }
  }
  private val timeouts: ScheduledExecutorService by lazy {
    Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "DriveSenseGeocodeTimeout").apply { isDaemon = true } }
  }

  /** Whether this phone has a geocoding backend at all. */
  fun present(): Boolean = try {
    Geocoder.isPresent()
  } catch (_: Exception) {
    false
  }

  /**
   * The addresses at a point, expo-location's shape; an empty list when the geocoder found none,
   * null without a geocoder, on any failure or after [TIMEOUT_MS].
   */
  fun reverse(context: Context, lat: Double, lng: Double, done: (List<Map<String, Any?>>?) -> Unit) {
    if (!lat.isFinite() || !lng.isFinite() || lat < -90.0 || lat > 90.0 || lng < -180.0 || lng > 180.0 || !present()) {
      done(null)
      return
    }
    val once = Once(done)
    val geocoder = Geocoder(context.applicationContext, Locale.getDefault())
    schedule(once)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      try {
        geocoder.getFromLocation(lat, lng, MAX_RESULTS, listener(once) { it.map(::reverseRecord) })
      } catch (_: Exception) {
        once.answer(null)
      }
    } else {
      blocking(once) {
        @Suppress("DEPRECATION")
        geocoder.getFromLocation(lat, lng, MAX_RESULTS)?.filterNotNull()?.map(::reverseRecord) ?: emptyList()
      }
    }
  }

  /**
   * The points a typed address names (`{ latitude, longitude }`, expo-location's `geocodeAsync`
   * shape); empty when it names none, null without a geocoder, on any failure or after [TIMEOUT_MS].
   */
  fun forward(context: Context, query: String, done: (List<Map<String, Any?>>?) -> Unit) {
    val q = query.trim()
    if (q.isEmpty() || q.length > MAX_QUERY_CHARS || !present()) {
      done(null)
      return
    }
    val once = Once(done)
    val geocoder = Geocoder(context.applicationContext, Locale.getDefault())
    schedule(once)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      try {
        geocoder.getFromLocationName(q, MAX_RESULTS, listener(once) { list -> list.mapNotNull(::pointRecord) })
      } catch (_: Exception) {
        once.answer(null)
      }
    } else {
      blocking(once) {
        @Suppress("DEPRECATION")
        geocoder.getFromLocationName(q, MAX_RESULTS)?.filterNotNull()?.mapNotNull(::pointRecord) ?: emptyList()
      }
    }
  }

  /** expo-location's `ReverseGeocodeResponse`, from Android's [Address]. */
  private fun reverseRecord(a: Address): Map<String, Any?> = GeocodeFields(
    featureName = a.featureName,
    subThoroughfare = a.subThoroughfare,
    thoroughfare = a.thoroughfare,
    subLocality = a.subLocality,
    locality = a.locality,
    subAdminArea = a.subAdminArea,
    adminArea = a.adminArea,
    postalCode = a.postalCode,
    countryName = a.countryName,
    countryCode = a.countryCode
  ).toRecord()

  private fun pointRecord(a: Address): Map<String, Any?>? {
    if (!a.hasLatitude() || !a.hasLongitude()) return null
    val lat = a.latitude
    val lng = a.longitude
    if (!lat.isFinite() || !lng.isFinite()) return null
    return linkedMapOf("latitude" to lat, "longitude" to lng)
  }

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  private fun listener(once: Once, map: (List<Address>) -> List<Map<String, Any?>>) = object : Geocoder.GeocodeListener {
    override fun onGeocode(addresses: MutableList<Address>) {
      once.answer(
        try {
          map(addresses.filterNotNull())
        } catch (_: Exception) {
          null
        }
      )
    }

    override fun onError(errorMessage: String?) {
      once.answer(null)
    }
  }

  private fun blocking(once: Once, work: () -> List<Map<String, Any?>>) {
    try {
      worker.execute {
        once.answer(
          try {
            work()
          } catch (_: Exception) {
            null // IOException: no network, the backend busy or refusing
          }
        )
      }
    } catch (_: Exception) {
      once.answer(null)
    }
  }

  private fun schedule(once: Once) {
    try {
      timeouts.schedule({ once.answer(null) }, TIMEOUT_MS, TimeUnit.MILLISECONDS)
    } catch (_: Exception) {
      // no timer: the geocoder's own answer (or error) still settles it
    }
  }

  /** Answers its callback at most once: the geocoder's answer or the timeout, whichever is first. */
  private class Once(private val done: (List<Map<String, Any?>>?) -> Unit) {
    private val settled = AtomicBoolean(false)

    fun answer(value: List<Map<String, Any?>>?) {
      if (settled.compareAndSet(false, true)) done(value)
    }
  }
}

/**
 * The parts of an [Address] the answer is made of, as plain strings, so the mapping (and the
 * district rule) is pure and runs in the JVM unit tests (GeocodeFieldsTest).
 */
internal data class GeocodeFields(
  val featureName: String?,
  val subThoroughfare: String?,
  val thoroughfare: String?,
  val subLocality: String?,
  val locality: String?,
  val subAdminArea: String?,
  val adminArea: String?,
  val postalCode: String?,
  val countryName: String?,
  val countryCode: String?
) {
  /**
   * The neighbourhood for the label: the sub-locality, else the feature's name when it reads like a
   * place name: some letters, no digit (a house number, a postcode, a plus code or a whole address
   * line all carry one), no comma, and not the street, the city, the county, the state or the
   * country again. Null when neither qualifies, and the label falls to the street as on iPhone.
   */
  fun district(): String? {
    clean(subLocality)?.let { return it }
    val name = clean(featureName) ?: return null
    if (!name.any { it.isLetter() } || name.any { it.isDigit() } || name.contains(',')) return null
    val same = listOf(thoroughfare, locality, subAdminArea, adminArea, countryName, postalCode)
      .any { other -> clean(other)?.equals(name, ignoreCase = true) == true }
    return if (same) null else name
  }

  /** expo-location's `ReverseGeocodeResponse` keys, in its order; blanks as null. */
  fun toRecord(): Map<String, Any?> = linkedMapOf(
    "city" to clean(locality),
    "district" to district(),
    "streetNumber" to clean(subThoroughfare),
    "street" to clean(thoroughfare),
    "region" to clean(adminArea),
    "subregion" to clean(subAdminArea),
    "country" to clean(countryName),
    "postalCode" to clean(postalCode),
    "name" to clean(featureName),
    "isoCountryCode" to clean(countryCode)
  )

  private companion object {
    fun clean(s: String?): String? = s?.trim()?.takeIf { it.isNotEmpty() }
  }
}
