//! Commit-graph lane layout.
//!
//! Walks commits in topological order, keeping a list of "lanes" (each lane is
//! the sha it is waiting to reach). For every row we emit the node column and
//! the line segments the renderer draws, so the frontend never needs to know
//! about parents.

use crate::git::RawCommit;
use serde::Serialize;

pub const TOP: u8 = 0;
pub const MID: u8 = 1;
pub const BOTTOM: u8 = 2;

/// [x1 lane, y1 anchor, x2 lane, y2 anchor, color index]
pub type Edge = [u16; 5];

#[derive(Serialize)]
pub struct Row {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub refs: Vec<String>,
    pub subject: String,
    pub col: u16,
    pub color: u16,
    pub edges: Vec<Edge>,
}

fn free_slot(lanes: &mut Vec<Option<u32>>, avoid: usize) -> usize {
    match lanes.iter().enumerate().position(|(i, l)| l.is_none() && i != avoid) {
        Some(i) => i,
        None => {
            lanes.push(None);
            lanes.len() - 1
        }
    }
}

/// Small integer ids for commit hashes, so lanes are copied and compared without touching strings.
#[derive(Default)]
struct Ids(std::collections::HashMap<String, u32>);

impl Ids {
    fn of(&mut self, sha: &str) -> u32 {
        if let Some(&id) = self.0.get(sha) {
            return id;
        }
        let id = self.0.len() as u32;
        self.0.insert(sha.to_string(), id);
        id
    }
}

pub fn layout(commits: Vec<RawCommit>) -> (Vec<Row>, usize) {
    let mut ids = Ids::default();
    // Each lane holds the id of the commit it is waiting to reach.
    let mut lanes: Vec<Option<u32>> = Vec::new();
    // Colour follows the lane's branch line rather than its index once assigned.
    let mut lane_colors: Vec<u16> = Vec::new();
    let mut next_color: u16 = 0;
    let mut max_lanes = 0usize;
    let mut rows = Vec::with_capacity(commits.len());

    for c in commits {
        let me = ids.of(&c.sha);
        let parents: Vec<u32> = c.parents.iter().map(|p| ids.of(p)).collect();
        let before = lanes.clone();
        let before_colors = lane_colors.clone();

        let col = match lanes.iter().position(|&l| l == Some(me)) {
            Some(i) => i,
            None => {
                let i = free_slot(&mut lanes, usize::MAX);
                lanes[i] = Some(me);
                i
            }
        };
        if lane_colors.len() < lanes.len() {
            lane_colors.resize(lanes.len(), 0);
        }
        if before.get(col).copied().flatten() != Some(me) {
            lane_colors[col] = next_color;
            next_color += 1;
        }
        let node_color = lane_colors[col];

        // Other lanes waiting on this commit converge into it.
        for (i, l) in lanes.iter_mut().enumerate() {
            if i != col && *l == Some(me) {
                *l = None;
            }
        }

        let mut parent_cols = Vec::new();
        lanes[col] = parents.first().copied();
        if !parents.is_empty() {
            parent_cols.push(col);
        }
        for &p in parents.iter().skip(1) {
            let i = match lanes.iter().position(|&l| l == Some(p)) {
                Some(i) => i,
                None => {
                    let i = free_slot(&mut lanes, col);
                    lanes[i] = Some(p);
                    if lane_colors.len() < lanes.len() {
                        lane_colors.resize(lanes.len(), 0);
                    }
                    lane_colors[i] = next_color;
                    next_color += 1;
                    i
                }
            };
            parent_cols.push(i);
        }
        while matches!(lanes.last(), Some(None)) {
            lanes.pop();
        }
        lane_colors.truncate(lanes.len().max(1));

        let mut edges: Vec<Edge> = Vec::new();
        for (j, h) in before.iter().enumerate() {
            let Some(h) = *h else { continue };
            let color = before_colors.get(j).copied().unwrap_or(0);
            if h == me {
                edges.push([j as u16, TOP as u16, col as u16, MID as u16, color]);
            } else {
                edges.push([j as u16, TOP as u16, j as u16, BOTTOM as u16, color]);
            }
        }
        for &k in &parent_cols {
            let color = lane_colors.get(k).copied().unwrap_or(node_color);
            edges.push([col as u16, MID as u16, k as u16, BOTTOM as u16, color]);
        }

        max_lanes = max_lanes.max(before.len()).max(lanes.len()).max(col + 1);
        rows.push(Row {
            sha: c.sha,
            parents: c.parents,
            author: c.author,
            email: c.email,
            time: c.time,
            refs: c.refs,
            subject: c.subject,
            col: col as u16,
            color: node_color,
            edges,
        });
    }
    (rows, max_lanes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(sha: &str, parents: &[&str]) -> RawCommit {
        RawCommit {
            sha: sha.into(),
            parents: parents.iter().map(|s| s.to_string()).collect(),
            author: String::new(),
            email: String::new(),
            time: 0,
            refs: vec![],
            subject: String::new(),
        }
    }

    #[test]
    fn merge_and_branch() {
        // M merges F into B; F and B both come from A.
        let (rows, max) = layout(vec![c("M", &["B", "F"]), c("F", &["A"]), c("B", &["A"]), c("A", &[])]);
        assert_eq!(max, 2);
        assert_eq!(rows[0].col, 0);
        assert_eq!(rows[1].col, 1); // F sits in the second lane
        assert_eq!(rows[2].col, 0);
        assert_eq!(rows[3].col, 0);
        // A receives the converging line from lane 1
        assert!(rows[3].edges.iter().any(|e| e[0] == 1 && e[2] == 0));
    }
}
