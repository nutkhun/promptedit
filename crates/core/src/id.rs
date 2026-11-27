//! Identifiers, encoded the way Swift's `UUID` is: an uppercase hyphenated string.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::str::FromStr;

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct Id(pub uuid::Uuid);

impl Id {
    pub fn new() -> Self {
        Id(uuid::Uuid::new_v4())
    }
    pub const fn from_u128(v: u128) -> Self {
        Id(uuid::Uuid::from_u128(v))
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut buf = uuid::Uuid::encode_buffer();
        f.write_str(self.0.hyphenated().encode_upper(&mut buf))
    }
}

impl fmt::Debug for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl FromStr for Id {
    type Err = uuid::Error;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        uuid::Uuid::parse_str(s).map(Id)
    }
}

impl Serialize for Id {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Id::from_str(&s).map_err(serde::de::Error::custom)
    }
}

/// Swift encodes a `[UUID: V]` dictionary as a flat array `[key, value, key, value, …]`
/// (UUID isn't a string key to `JSONEncoder`). Kept in key order for stable output.
pub mod uuid_keyed_map {
    use super::Id;
    use serde::de::{SeqAccess, Visitor};
    use serde::ser::SerializeSeq;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::BTreeMap;
    use std::marker::PhantomData;

    pub fn serialize<S, V>(map: &Option<BTreeMap<Id, V>>, s: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
        V: Serialize,
    {
        let Some(map) = map else { return s.serialize_none() };
        #[derive(Serialize)]
        #[serde(untagged)]
        enum Item<'a, V> {
            K(&'a Id),
            V(&'a V),
        }
        let mut seq = s.serialize_seq(Some(map.len() * 2))?;
        for (k, v) in map {
            seq.serialize_element(&Item::<V>::K(k))?;
            seq.serialize_element(&Item::V(v))?;
        }
        seq.end()
    }

    pub fn deserialize<'de, D, V>(d: D) -> Result<Option<BTreeMap<Id, V>>, D::Error>
    where
        D: Deserializer<'de>,
        V: Deserialize<'de>,
    {
        struct Vis<V>(PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for Vis<V> {
            type Value = Option<BTreeMap<Id, V>>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an alternating [uuid, value, …] array or null")
            }
            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_some<D2: Deserializer<'de>>(self, d: D2) -> Result<Self::Value, D2::Error> {
                d.deserialize_seq(self)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut out = BTreeMap::new();
                while let Some(k) = seq.next_element::<Id>()? {
                    let v = seq
                        .next_element::<V>()?
                        .ok_or_else(|| serde::de::Error::custom("odd number of items in keyed array"))?;
                    out.insert(k, v);
                }
                Ok(Some(out))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                // Also accept a plain object, in case a newer encoder writes one.
                let mut out = BTreeMap::new();
                while let Some((k, v)) = map.next_entry::<Id, V>()? {
                    out.insert(k, v);
                }
                Ok(Some(out))
            }
        }
        d.deserialize_option(Vis(PhantomData))
    }
}
