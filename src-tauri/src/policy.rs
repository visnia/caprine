use url::Url;

pub const MESSENGER: &str = "https://www.messenger.com";

pub fn is_messenger(url: &Url) -> bool {
    url.origin().ascii_serialization() == MESSENGER
}

pub fn is_authentication(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some("www.facebook.com" | "web.facebook.com")
        )
        && [
            "/login",
            "/checkpoint",
            "/two_factor",
            "/two_step_verification",
        ]
        .iter()
        .any(|prefix| url.path() == *prefix || url.path().starts_with(&format!("{prefix}/")))
}

pub fn external_url(input: &str) -> Result<Url, String> {
    let mut url = Url::parse(input).map_err(|_| "Invalid URL")?;
    for _ in 0..5 {
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("Only HTTP(S) links without embedded credentials are allowed".into());
        }
        let tracking = matches!(
            url.host_str(),
            Some("l.facebook.com" | "lm.facebook.com" | "l.messenger.com")
        ) && url.path() == "/l.php";
        if !tracking {
            return Ok(url);
        }
        let destination = url
            .query_pairs()
            .find(|(key, _)| key == "u")
            .map(|(_, value)| value.into_owned())
            .ok_or("Tracking link has no destination")?;
        url = Url::parse(&destination).map_err(|_| "Invalid tracking destination")?;
    }
    Err("Too many tracking redirects".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_origin_is_exact() {
        assert!(is_messenger(
            &Url::parse("https://www.messenger.com/t/123").unwrap()
        ));
        for url in [
            "http://www.messenger.com",
            "https://messenger.com",
            "https://www.messenger.com.evil.test",
            "https://www.messenger.com:8443",
            "https://www.facebook.com/messages",
        ] {
            assert!(!is_messenger(&Url::parse(url).unwrap()), "{url}");
        }
    }

    #[test]
    fn unwraps_tracking_and_validates_the_destination() {
        assert_eq!(
            external_url(
                "https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fx%3Fa%3D1&h=tracking"
            )
            .unwrap()
            .as_str(),
            "https://example.com/x?a=1"
        );
        assert!(external_url("https://l.messenger.com/l.php?u=javascript%3Aalert(1)").is_err());
        assert!(external_url("file:///C:/secret").is_err());
        assert!(external_url("https://user:password@example.com").is_err());
        assert_eq!(
            external_url("https://example.com/l.php?u=other")
                .unwrap()
                .host_str(),
            Some("example.com")
        );
    }

    #[test]
    fn authentication_exceptions_do_not_allow_facebook_messages() {
        assert!(is_authentication(
            &Url::parse("https://www.facebook.com/checkpoint/123").unwrap()
        ));
        for url in [
            "https://www.facebook.com/messages",
            "https://www.facebook.com/login.evil",
            "http://www.facebook.com/login",
            "https://www.facebook.com.evil.test/login",
        ] {
            assert!(!is_authentication(&Url::parse(url).unwrap()), "{url}");
        }
    }
}
