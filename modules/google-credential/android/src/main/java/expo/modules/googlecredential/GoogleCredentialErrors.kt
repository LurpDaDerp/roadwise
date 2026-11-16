package expo.modules.googlecredential

import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialInterruptedException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException

/**
 * The codes Sign in with Google rejects with. The JS side (src/features/auth/googleCredential.ts)
 * names the same strings: only CANCELLED is told apart there (backing out shows nothing); every
 * other one is the sign-in screen's one generic error.
 */
object GoogleCredentialErrors {
  const val CANCELLED = "ERR_GOOGLE_CREDENTIAL_CANCELLED"
  /** No Google account could be offered (none on the phone, or the sheet was turned off). */
  const val NO_CREDENTIAL = "ERR_GOOGLE_CREDENTIAL_NONE"
  /** The sheet was interrupted (the app went to the background): tapping again works. */
  const val INTERRUPTED = "ERR_GOOGLE_CREDENTIAL_INTERRUPTED"
  /** No credential provider on the phone (no Google Play services, an old Android without one). */
  const val UNAVAILABLE = "ERR_GOOGLE_CREDENTIAL_UNAVAILABLE"
  const val NO_ACTIVITY = "ERR_GOOGLE_CREDENTIAL_NO_ACTIVITY"
  const val FAILED = "ERR_GOOGLE_CREDENTIAL_FAILED"

  fun codeFor(e: GetCredentialException): String = when (e) {
    is GetCredentialCancellationException -> CANCELLED
    is NoCredentialException -> NO_CREDENTIAL
    is GetCredentialInterruptedException -> INTERRUPTED
    is GetCredentialProviderConfigurationException, is GetCredentialUnsupportedException -> UNAVAILABLE
    else -> FAILED
  }
}
