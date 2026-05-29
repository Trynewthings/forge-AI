//! Cross-turn user interrogation hooked into the conversation loop.
//!
//! When the model fires the `AskUser` tool we don't want to free-form
//! continue the conversation — that would muddle assistant/user turn
//! alternation and leak the model's prose into the answer. Instead the
//! conversation loop intercepts `AskUser`, calls a `UserQuestioner`
//! implementation (server: HTTP-bridged oneshot, CLI: stdin prompt, tests:
//! recording stub), and feeds the structured answer back as a normal
//! `tool_result`.
//!
//! Same general shape as `PermissionPrompter` in `permissions.rs` — kept
//! deliberately small so the runtime stays platform-agnostic.

/// What the model asks. Mirrors the JSON schema we expose on the AskUser
/// tool: a single question, optional short header for UI chip, 0–4
/// pre-canned options. When `options` is empty the prompter should fall
/// back to a pure free-text input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserQuestionRequest {
    pub question: String,
    pub header: Option<String>,
    pub options: Vec<UserQuestionOption>,
    /// When `true`, the prompter offers an "Other" affordance even if
    /// `options` is non-empty. Defaults true on the tool's JSON side.
    pub allow_other: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserQuestionOption {
    pub label: String,
    pub description: Option<String>,
}

/// What the user (or a stub) gives back.
///
/// `Selected` carries the picked option's label so it stays human-readable
/// when the model reads the tool_result; `OtherText` carries the typed
/// reply; `Dismissed` lets the user bail without answering (the model
/// then decides whether to retry, ask differently, or proceed with a
/// default).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserQuestionAnswer {
    Selected { index: usize, label: String },
    OtherText { text: String },
    Dismissed,
}

pub trait UserQuestioner: Send {
    fn ask(&mut self, request: &UserQuestionRequest) -> UserQuestionAnswer;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Recording stub used by the conversation tests to verify the loop
    /// actually called into the questioner and threaded the answer back
    /// as a tool_result.
    pub struct RecordingQuestioner {
        pub seen: Vec<UserQuestionRequest>,
        pub canned: UserQuestionAnswer,
    }

    impl UserQuestioner for RecordingQuestioner {
        fn ask(&mut self, request: &UserQuestionRequest) -> UserQuestionAnswer {
            self.seen.push(request.clone());
            self.canned.clone()
        }
    }

    #[test]
    fn recording_stub_returns_canned_answer() {
        let mut q = RecordingQuestioner {
            seen: Vec::new(),
            canned: UserQuestionAnswer::Selected {
                index: 1,
                label: "B".to_string(),
            },
        };
        let req = UserQuestionRequest {
            question: "pick".to_string(),
            header: None,
            options: vec![
                UserQuestionOption {
                    label: "A".to_string(),
                    description: None,
                },
                UserQuestionOption {
                    label: "B".to_string(),
                    description: None,
                },
            ],
            allow_other: true,
        };
        let answer = q.ask(&req);
        assert_eq!(
            answer,
            UserQuestionAnswer::Selected {
                index: 1,
                label: "B".to_string()
            }
        );
        assert_eq!(q.seen.len(), 1);
    }
}
