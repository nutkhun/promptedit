//! Standard base64 decoding, for binary data that arrives inside JSON (encoded video chunks,
//! mixed audio) from the webview.

fn value(c: u8) -> Option<u32> {
    Some(match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    } as u32)
}

pub fn decode(text: &str) -> Result<Vec<u8>, String> {
    let bytes: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let body = match bytes.iter().rposition(|&b| b != b'=') {
        Some(i) => &bytes[..=i],
        None => &[][..],
    };
    let mut out = Vec::with_capacity(body.len() * 3 / 4 + 3);
    let mut acc = 0u32;
    let mut bits = 0;
    for &c in body {
        acc = (acc << 6) | value(c).ok_or("Bad base64 data.")?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn decodes() {
        assert_eq!(super::decode("").unwrap(), b"");
        assert_eq!(super::decode("Zg==").unwrap(), b"f");
        assert_eq!(super::decode("Zm8=").unwrap(), b"fo");
        assert_eq!(super::decode("Zm9v").unwrap(), b"foo");
        assert_eq!(super::decode("Zm9vYmFy").unwrap(), b"foobar");
        assert_eq!(super::decode("AP8Q").unwrap(), [0u8, 255, 16]);
        assert!(super::decode("Zm9v!").is_err());
    }
}
