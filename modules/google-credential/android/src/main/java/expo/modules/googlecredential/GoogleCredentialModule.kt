package expo.modules.googlecredential

import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Sign in with Google on Android: Credential Manager's "Sign in with Google" sheet
 * (GetSignInWithGoogleOption), which hands back a Google ID token for the web client id, with the
 * caller's (hashed) nonce baked in. The JS side gives the token and the raw nonce to Supabase
 * (`signInWithIdToken`), exactly as the iPhone does with the token expo-auth-session gets it.
 *
 * Google verifies the app itself (its package and signing certificate, against the Android OAuth
 * clients of the same Cloud project), so nothing app-specific is passed in but the web client id.
 * No redirect, no custom URL scheme, no browser. Nothing is stored here.
 *
 * Every failure rejects with a code from [GoogleCredentialErrors]: backing out of the sheet is
 * `ERR_GOOGLE_CREDENTIAL_CANCELLED`, which the sign-in screen treats as nothing happened.
 */
class GoogleCredentialModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GoogleCredential")

    // The sheet is shown over the current activity, so the request starts on the main thread; the
    // answer comes back on it too.
    AsyncFunction("signInAsync") { serverClientId: String, nonce: String, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject(CodedException(GoogleCredentialErrors.NO_ACTIVITY, "No activity to show Sign in with Google over", null))
        return@AsyncFunction
      }
      if (serverClientId.isBlank() || nonce.isBlank()) {
        promise.reject(CodedException(GoogleCredentialErrors.FAILED, "A client id and a nonce are required", null))
        return@AsyncFunction
      }
      val option = GetSignInWithGoogleOption.Builder(serverClientId).setNonce(nonce).build()
      val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
      try {
        CredentialManager.create(activity).getCredentialAsync(
          activity,
          request,
          CancellationSignal(),
          ContextCompat.getMainExecutor(activity),
          object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
            override fun onResult(result: GetCredentialResponse) {
              val credential = result.credential
              if (credential !is CustomCredential || credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                promise.reject(CodedException(GoogleCredentialErrors.FAILED, "Credential Manager returned no Google ID token", null))
                return
              }
              try {
                promise.resolve(GoogleIdTokenCredential.createFrom(credential.data).idToken)
              } catch (e: GoogleIdTokenParsingException) {
                promise.reject(CodedException(GoogleCredentialErrors.FAILED, "The Google ID token could not be read", e))
              }
            }

            override fun onError(e: GetCredentialException) {
              promise.reject(CodedException(GoogleCredentialErrors.codeFor(e), e.message?.toString() ?: e.type, e))
            }
          }
        )
      } catch (e: Exception) {
        // a phone without a credential provider at all can throw before the sheet
        promise.reject(CodedException(GoogleCredentialErrors.UNAVAILABLE, e.message ?: "Credential Manager is not available", e))
      }
    }.runOnQueue(Queues.MAIN)
  }
}
