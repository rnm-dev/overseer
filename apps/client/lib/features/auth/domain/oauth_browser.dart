abstract interface class OAuthBrowser {
  Future<Uri> authenticate(Uri authorizationUrl, Uri callbackUrl);
}
