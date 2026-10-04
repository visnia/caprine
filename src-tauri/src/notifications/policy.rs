use std::collections::HashMap;

pub fn thread_url(input: &str) -> Option<(String, String)> {
    let mut url = url::Url::parse(input).ok()?;
    if !crate::policy::is_messenger(&url) {
        return None;
    }
    let encoded = url
        .path()
        .strip_prefix("/e2ee/t/")
        .or_else(|| url.path().strip_prefix("/t/"))?
        .trim_end_matches('/');
    let path = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .ok()?;
    if path.is_empty()
        || path.len() > 200
        || !path
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
    {
        return None;
    }
    let id = path.into_owned();
    url.set_query(None);
    url.set_fragment(None);
    Some((id, url.to_string()))
}
pub fn tag_thread(tag: &str) -> Option<(String, String)> {
    thread_url(tag).or_else(|| {
        ["thread:", "thread_", "thread=", "conversation:"]
            .iter()
            .find_map(|prefix| {
                thread_url(&format!(
                    "https://www.messenger.com/t/{}/",
                    tag.strip_prefix(prefix)?
                ))
            })
    })
}
pub fn metadata_match<'a>(
    tag: &str,
    title: &str,
    metadata: impl Iterator<Item = (&'a String, &'a String, Option<&'a str>)>,
) -> Option<usize> {
    let candidates: Vec<_> = metadata.enumerate().collect();
    // Consume each matching page invocation once, in order. A second real
    // identical message still owns a separate metadata/native pair.
    if !tag.is_empty() {
        if let Some((i, _)) = candidates
            .iter()
            .find(|(_, (t, name, _))| t.as_str() == tag && name.as_str() == title)
        {
            return Some(*i);
        }
    }
    let matches: Vec<_> = candidates
        .iter()
        .filter(|(_, (t, name, _))| name.as_str() == title && (tag.is_empty() || t.is_empty()))
        .collect();
    let first = matches.first()?;
    // Same-name conversations are ambiguous without a discriminating tag.
    if matches
        .iter()
        .any(|(_, (_, _, thread))| *thread != first.1 .2)
    {
        return None;
    }
    Some(first.0)
}
pub fn suppression(
    muted: bool,
    focused: bool,
    active: Option<&str>,
    incoming: Option<&str>,
) -> Option<&'static str> {
    if muted {
        Some("muted")
    } else if focused && incoming.is_some() && active == incoming {
        Some("focused_same_thread")
    } else {
        None
    }
}
#[derive(Default)]
pub struct Arbitration {
    threads: HashMap<String, Seen>,
    // A primary without a thread could be any conversation's message. The
    // sidebar is a last resort, so it yields for the window instead of
    // matching text against that primary.
    unknown_primary: Option<u64>,
}
#[derive(Default)]
struct Seen {
    primary: Option<u64>,
    fallback_credit: Option<u64>,
}
impl Arbitration {
    pub fn decide(
        &mut self,
        thread: Option<&str>,
        primary: bool,
        now: u64,
    ) -> Result<(), &'static str> {
        const WINDOW: u64 = 4000;
        self.threads.retain(|_, seen| {
            seen.primary
                .into_iter()
                .chain(seen.fallback_credit)
                .any(|at| now.saturating_sub(at) <= WINDOW)
        });
        let Some(thread) = thread else {
            return if primary {
                self.unknown_primary = Some(now);
                Ok(())
            } else {
                Err("unknown_fallback_thread")
            };
        };
        if !primary
            && self
                .unknown_primary
                .is_some_and(|at| now.saturating_sub(at) <= WINDOW)
        {
            return Err("recent_unknown_primary");
        }
        let seen = self.threads.entry(thread.into()).or_default();
        if primary {
            seen.primary = Some(now);
            if seen
                .fallback_credit
                .take()
                .is_some_and(|at| now.saturating_sub(at) <= WINDOW)
            {
                return Err("fallback_already_owned_one_event");
            }
        } else {
            if seen
                .primary
                .is_some_and(|at| now.saturating_sub(at) <= WINDOW)
            {
                return Err("recent_primary_for_thread");
            }
            if seen
                .fallback_credit
                .is_some_and(|at| now.saturating_sub(at) <= WINDOW)
            {
                return Err("recent_fallback_for_thread");
            }
            seen.fallback_credit = Some(now);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordering_never_swallows_two_primary_messages_or_other_threads() {
        let mut a = Arbitration::default();
        assert!(a.decide(Some("a"), true, 0).is_ok());
        assert!(a.decide(Some("a"), false, 1200).is_err());
        assert!(a.decide(Some("a"), true, 1300).is_ok());
        assert!(a.decide(Some("b"), false, 1400).is_ok());
        assert!(a.decide(Some("b"), true, 1500).is_err());
        assert!(a.decide(Some("b"), true, 1600).is_ok());
        assert!(a.decide(Some("a"), false, 6000).is_ok());
        assert!(a.decide(None, true, 6100).is_ok());
        assert!(a.decide(None, true, 6200).is_ok());
    }
    #[test]
    fn unknown_primary_blocks_fallback_copies_but_never_other_primaries() {
        let mut a = Arbitration::default();
        assert!(a.decide(None, true, 0).is_ok());
        assert_eq!(
            a.decide(Some("g"), false, 1200),
            Err("recent_unknown_primary")
        );
        assert!(a.decide(Some("g"), true, 1300).is_ok());
        assert!(a.decide(Some("h"), true, 1400).is_ok());
        assert!(a.decide(Some("k"), false, 5000).is_ok());
    }
    #[test]
    fn focused_other_thread_and_unknown_thread_still_notify() {
        assert_eq!(
            suppression(false, true, Some("a"), Some("a")),
            Some("focused_same_thread")
        );
        assert_eq!(suppression(false, true, Some("a"), Some("b")), None);
        assert_eq!(suppression(false, false, Some("a"), Some("a")), None);
        assert_eq!(suppression(false, true, None, None), None);
        assert_eq!(suppression(true, false, None, Some("b")), Some("muted"));
    }
    #[test]
    fn only_messenger_thread_urls_can_be_activated() {
        assert_eq!(
            thread_url("https://www.messenger.com/t/abc%3A123/")
                .unwrap()
                .0,
            "abc:123"
        );
        assert_eq!(
            thread_url("https://www.messenger.com/e2ee/t/123/?x=y")
                .unwrap()
                .1,
            "https://www.messenger.com/e2ee/t/123/"
        );
        for url in [
            "https://example.com/t/123",
            "https://www.messenger.com/t/12/evil",
            "https://www.messenger.com/t/12%2Fevil",
            "https://www.messenger.com/login",
            "javascript:alert(1)",
        ] {
            assert!(thread_url(url).is_none());
        }
        assert!(tag_thread("123").is_none());
        assert_eq!(tag_thread("thread:123").unwrap().0, "123");
    }

    #[test]
    fn metadata_pairs_are_consumed_individually_and_ambiguous_names_are_not_guessed() {
        let mut metadata = vec![
            ("thread:1".to_string(), "Alice".to_string(), Some("1")),
            ("thread:1".to_string(), "Alice".to_string(), Some("1")),
        ];
        for _ in 0..2 {
            let index = metadata_match(
                "thread:1",
                "Alice",
                metadata.iter().map(|(tag, title, id)| (tag, title, *id)),
            )
            .unwrap();
            metadata.remove(index);
        }
        assert!(metadata.is_empty());
        metadata = vec![
            (String::new(), "Same name".into(), Some("1")),
            (String::new(), "Same name".into(), Some("2")),
        ];
        assert_eq!(
            metadata_match(
                "",
                "Same name",
                metadata.iter().map(|(tag, title, id)| (tag, title, *id))
            ),
            None
        );
    }
}
