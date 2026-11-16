package expo.modules.googlecredential

import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialInterruptedException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import org.junit.Assert.assertEquals
import org.junit.Test

class GoogleCredentialErrorsTest {
  @Test
  fun backingOutIsCancelledAndNothingElseIs() {
    assertEquals(GoogleCredentialErrors.CANCELLED, GoogleCredentialErrors.codeFor(GetCredentialCancellationException("closed")))
    assertEquals(GoogleCredentialErrors.NO_CREDENTIAL, GoogleCredentialErrors.codeFor(NoCredentialException("no accounts")))
    assertEquals(GoogleCredentialErrors.INTERRUPTED, GoogleCredentialErrors.codeFor(GetCredentialInterruptedException("background")))
    assertEquals(GoogleCredentialErrors.UNAVAILABLE, GoogleCredentialErrors.codeFor(GetCredentialProviderConfigurationException("no provider")))
    assertEquals(GoogleCredentialErrors.UNAVAILABLE, GoogleCredentialErrors.codeFor(GetCredentialUnsupportedException("old android")))
    assertEquals(GoogleCredentialErrors.FAILED, GoogleCredentialErrors.codeFor(GetCredentialUnknownException("?")))
  }

  @Test
  fun codesMatchTheJsSide() {
    // src/features/auth/googleCredential.ts GOOGLE_CREDENTIAL_CANCELLED
    assertEquals("ERR_GOOGLE_CREDENTIAL_CANCELLED", GoogleCredentialErrors.CANCELLED)
  }
}
