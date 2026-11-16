# Credential Manager finds its Google Play services provider by reflection: keep it when R8 shrinks
# the app (developer.android.com/identity/sign-in/credential-manager, "Add support for Play services").
-if class androidx.credentials.CredentialManager
-keep class androidx.credentials.playservices.** {
  *;
}
