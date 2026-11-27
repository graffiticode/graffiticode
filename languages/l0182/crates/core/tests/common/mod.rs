// SPDX-License-Identifier: MIT

//! Programs built node by node, the way the parser lays out its pool.

#![allow(dead_code)]

use serde_json::{Value as Json, json};

#[derive(Default)]
pub struct Prog {
    pool: serde_json::Map<String, Json>,
    next: u32,
}

impl Prog {
    pub fn node(&mut self, tag: &str, elts: Vec<Json>) -> u32 {
        self.next += 1;
        self.pool.insert(self.next.to_string(), json!({ "tag": tag, "elts": elts }));
        self.next
    }
    pub fn form(&mut self, tag: &str, elts: &[u32]) -> u32 {
        self.node(tag, elts.iter().map(|&elt| json!(elt)).collect())
    }
    pub fn str(&mut self, s: &str) -> u32 {
        self.node("STR", vec![json!(s)])
    }
    pub fn ident(&mut self, name: &str) -> u32 {
        self.node("IDENT", vec![json!(name)])
    }
    /// `survey [id <id> session-id <session> <extra…>]`, the session a node or absent.
    pub fn survey(&mut self, id: &str, session: Option<u32>, extra: &[u32]) -> u32 {
        let id = self.str(id);
        let id = self.form("ID", &[id]);
        let mut attrs = vec![id];
        if let Some(session) = session {
            attrs.push(self.form("SESSION_ID", &[session]));
        }
        attrs.extend_from_slice(extra);
        let list = self.form("LIST", &attrs);
        self.form("SURVEY", &[list])
    }
    pub fn session(&mut self, id: &str, session: &str) -> u32 {
        let session = self.str(session);
        self.survey(id, Some(session), &[])
    }
    /// `get "instance" (get "survey" <of>)`.
    pub fn instance_of(&mut self, of: u32) -> u32 {
        let survey = self.str("survey");
        let record = self.form("GET", &[survey, of]);
        let instance = self.str("instance");
        self.form("GET", &[instance, record])
    }
    pub fn lambda(&mut self, params: &[&str], body: u32) -> u32 {
        let params: Vec<u32> = params.iter().map(|param| self.ident(param)).collect();
        let params = self.form("LIST", &params);
        let lambda = self.form("LAMBDA", &[params, body]);
        self.form("PAREN", &[lambda])
    }
    pub fn program(mut self, exprs: &[u32]) -> Json {
        let exprs = self.form("EXPRS", exprs);
        let root = self.form("PROG", &[exprs]);
        self.pool.insert("root".to_owned(), json!(root));
        Json::Object(self.pool)
    }
}
