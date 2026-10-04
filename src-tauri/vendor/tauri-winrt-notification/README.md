Source: published tauri-winrt-notification 0.8.1, MIT/Apache-2.0 (licenses included).

Caprine's only source change is `show_with_handle`, with `show` delegating to it.
Upstream `show` returns `()` and drops the ToastNotification. Retaining that
object lets Caprine own its activation lifetime and pass it to ToastNotifier.Hide
when WebView2 requests closure. XML rendering and event registration are unchanged.
Remove this local copy when upstream provides an equivalent handle-returning API.
