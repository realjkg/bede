from pydantic import model_validator, BaseModel, EmailStr, Field
from typing import List, Optional, Literal
from enum import Enum
from datetime import date


class GradeStage(str, Enum):
    foundations = "K-2"        # Grammar stage: exploration & discovery
    core_mastery = "3-5"       # Logic stage: building knowledge
    independent = "6-8"        # Rhetoric stage: application & mastery


# Valid grade values a visitor can pick, in display order — mirrors
# services/ai_service.py's _GRADE_DESCRIPTORS keys.
VALID_GRADES = ["K", "1", "2", "3", "4", "5", "6", "7", "8"]


def grade_to_stage(grade: str) -> GradeStage:
    """Maps a grade string to its Mater Amabilis-aligned stage (see
    services/ai_service.py's _STAGE_GUIDANCE for what each stage means for
    narration pacing). Unrecognized input defaults to foundations — the
    gentlest, least presumptuous stage — rather than raising, since this
    only ever drives tone/pacing, never a security-relevant decision."""
    g = grade.strip().upper()
    if g in ("K", "0", "1", "2"):
        return GradeStage.foundations
    if g in ("3", "4", "5"):
        return GradeStage.core_mastery
    if g in ("6", "7", "8"):
        return GradeStage.independent
    return GradeStage.foundations


class TermSchedule(str, Enum):
    """Mater Amabilis is organized around a 3-term (trimester) year; some
    families run a 4-quarter year instead. The schedule choice drives the
    poetry/term rotation length and how term outcomes are framed."""
    trimester = "trimester"   # 3 terms per year (Mater Amabilis default)
    quarterly = "quarterly"   # 4 quarters per year


# Foundational core areas the parent tracks term-by-term. Every learner is
# expected to be EXPOSED to all of a term's topics and to reach MASTERY of
# the parent's chosen topics (up to 3 per area per term) — see
# SessionConfig.term_mastery_topics and services/ai_service.py's
# _term_outcomes_note.
CORE_AREAS = {
    "phonics_language":    "Phonics & Language",
    "mathematics":         "Math",
    "reading_literature":  "Reading & Literature",
    "science":             "Science",
    "writing_composition": "Writing & Composition",
}

# Which subjects gauge which core areas — a subject's sessions produce the
# narration evidence that feeds that area's term-mastery picture.
SUBJECT_CORE_AREAS = {}  # populated after Subject is defined below


class Subject(str, Enum):
    morning_time = "morning_time"       # Bible, hymn, poetry, prayer
    living_books = "living_books"       # Mater Amabilis literature
    mathematics = "mathematics"         # Discovery-based math
    nature_study = "nature_study"       # Observation, nature journal
    history = "history"                 # Story-based history & geography
    language_arts = "language_arts"     # Narration, copywork, grammar
    science = "science"                 # Botany, zoology, earth science
    art_music = "art_music"             # Composer & artist study
    saints = "saints"                   # Saints, catechism, virtue formation
    free_study = "free_study"           # Child-directed exploration


SUBJECT_DURATIONS = {
    Subject.morning_time: 20,
    Subject.living_books: 25,
    Subject.mathematics: 20,
    Subject.nature_study: 20,
    Subject.history: 20,
    Subject.language_arts: 15,
    Subject.science: 20,
    Subject.art_music: 15,
    Subject.saints: 15,
    Subject.free_study: 20,
}

SUBJECT_LABELS = {
    Subject.morning_time: "Morning Time",
    Subject.living_books: "Living Books",
    Subject.mathematics: "Mathematics",
    Subject.nature_study: "Nature Study",
    Subject.history: "History & Geography",
    Subject.language_arts: "Language Arts",
    Subject.science: "Science",
    Subject.art_music: "Art & Music",
    Subject.saints: "Saints & Catechism",
    Subject.free_study: "Free Study",
}


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class LessonResume(BaseModel):
    """
    One subject's "pick up where we left off" note, written by the parent
    before the day's session — the curriculum director telling Bede exactly
    where they and the child stopped, so the subject resumes mid-thread
    instead of opening as though the material were new.

    `subject` is a Subject enum member, which is the whole enforcement of
    "if it isn't a subject Bede teaches, it can't be introduced": a note can
    only ever attach to one of the ten subjects in the curriculum, never to
    an arbitrary parent-invented topic. SessionConfig's validator narrows
    that further to subjects actually scheduled for this student today.

    The free-text fields are parent-supplied context, so they take the same
    route every other parent field does — services/ai_service.py's
    _sanitize_parent_field (HTML, injection phrasing, credential shapes) on
    the way into the prompt, and no authority over Bede's rules once there
    (see _lesson_resume_note).
    """
    subject: Subject
    # Where the last lesson actually stopped — the one required field; a
    # resume note with nothing to resume from is just noise in the prompt.
    stopped_at: str = Field(..., min_length=1, max_length=300)
    # What the parent wants taken up next, if they have something specific
    # in mind. Left unset, Bede decides the next step itself.
    next_step: Optional[str] = Field(default=None, max_length=300)
    # Where the child struggled last time, so Bede can slow down there
    # rather than rediscovering the difficulty from scratch.
    sticking_point: Optional[str] = Field(default=None, max_length=300)
    # ISO date (YYYY-MM-DD) of the lesson being resumed, so Bede can tell a
    # thread picked up this morning from one dropped three weeks ago. Kept a
    # string rather than a date so config dicts stay JSON-serializable for
    # encrypt_json (core/encryption.py).
    recorded_on: Optional[str] = Field(default=None, max_length=10)


SUBJECT_CORE_AREAS.update({
    Subject.language_arts: ["phonics_language", "writing_composition"],
    Subject.mathematics:   ["mathematics"],
    Subject.living_books:  ["reading_literature", "writing_composition"],
    Subject.science:       ["science"],
    Subject.nature_study:  ["science"],
})


class SessionConfig(BaseModel):
    student_name: str = Field(..., min_length=1, max_length=50)
    grade: str = Field(..., description="e.g. '3' or 'K'")
    grade_stage: GradeStage
    # Biological sex, not a separate "gender identity" concept — consistent
    # with Bede's classical natural-law formation (docs/CONSTITUTION.md).
    # Optional for an English-only deployment, where it's never asked for or
    # used. Required by routers/pod.py's save_pod_configs whenever LOCALE is
    # a non-English value: Spanish, Italian, and Polish all need this for
    # grammatically correct address ("bienvenido"/"bienvenida", and in
    # Polish even past-tense verb agreement) — see
    # services/ai_service.py's _locale_directive and docs/LOCALIZATION.md.
    # Every locale currently supported happens to be a grammatically
    # gendered language; a future non-gendered addition (Tagalog, from the
    # original locale list, has no grammatical gender at all) would need
    # this requirement revisited rather than assumed to still apply.
    sex: Optional[Literal["male", "female"]] = None
    subjects: List[Subject] = Field(
        default=[
            Subject.morning_time,
            Subject.living_books,
            Subject.mathematics,
            Subject.nature_study,
            Subject.history,
            Subject.language_arts,
        ]
    )
    lesson_focus: Optional[str] = None       # Parent's note for today
    faith_emphasis: Optional[str] = None     # Scripture or virtue focus
    current_unit: Optional[str] = None       # e.g. "Ancient Egypt", "Fractions"
    voice_required: bool = True              # False for mute students (PIN-only auth)

    # The session's hard stop, in minutes — on by default and there by
    # design: the session concludes automatically when it's reached. 2-hour
    # default; a parent (behind the parent password) may raise it, but the
    # schema ceiling means no stored value can ever exceed 4 hours. Configs
    # saved before this field existed load as the 2-hour default. A
    # mandatory 10-minute break runs after every hour of session time
    # regardless of this value (frontend gradeTimer.ts).
    session_cap_minutes: int = Field(default=120, ge=30, le=240)
    # Parent-set cap on total on-screen tutoring minutes before a mandatory
    # eye-rest break is inserted, independent of the grade-based block/break
    # cycle. None = no additional cap.
    screen_time_limit_minutes: Optional[int] = Field(default=None, ge=15, le=480)
    # Length of the mandatory break once the cap is reached. 30-minute floor
    # enforced here so a weaker value can never be saved, even if the client
    # is bypassed.
    eye_rest_break_minutes: int = Field(default=30, ge=30, le=120)
    # Remembers the child's own last choice for Bede's spoken narration (the
    # mute/unmute button in SocraticChat.tsx) — distinct from voice_required
    # above, which is about login voice-biometric verification, not TTS
    # output. Updated via PATCH /pod/configs/{student_name}/voice-narration
    # (routers/pod.py), reachable by the child themselves, not just the parent.
    voice_narration_enabled: bool = True
    # Parent-side lock on the chat appearance picker (background theme +
    # bubble color). When True, the child's session hides the picker
    # entirely — whatever look the device already has stays put. For
    # children who find open-ended customization a distraction magnet
    # (ADD/ADHD tendencies especially), choice happens with the parent,
    # not mid-lesson. A parent-role session still sees the picker.
    appearance_locked: bool = False

    # ── Term schedule & outcomes ──────────────────────────────────────────
    # Mater Amabilis default is a 3-term year; quarterly gives 4. current_term
    # is 1-based and capped by the schedule (validated below).
    term_schedule: TermSchedule = TermSchedule.trimester
    current_term: int = Field(default=1, ge=1, le=4)
    # Parent's chosen mastery outcomes for the current term: up to 3 topics
    # per core area (keys from CORE_AREAS). Exposure to every listed topic is
    # expected across the term; mastery of these named topics is the outcome.
    # Bede steers sessions toward them and records per-topic evidence via
    # assess_narration's term_topic fields.
    term_mastery_topics: dict[str, list[str]] = Field(default_factory=dict)

    # ── "Meet me where I am" — resuming an interrupted lesson ─────────────
    # At most one note per subject (later duplicates win; see the validator),
    # and only for subjects actually scheduled for this student today —
    # anything else is dropped rather than rejected, so a parent trimming
    # today's subject list never gets a save error over a stale note.
    lesson_resume: List[LessonResume] = Field(default_factory=list, max_length=len(Subject))

    @model_validator(mode="after")
    def _validate_term(self):
        max_term = 3 if self.term_schedule == TermSchedule.trimester else 4
        if self.current_term > max_term:
            self.current_term = max_term
        cleaned: dict[str, list[str]] = {}
        for area, topics in (self.term_mastery_topics or {}).items():
            if area not in CORE_AREAS:
                continue
            kept = [t.strip()[:120] for t in topics if t and t.strip()][:3]
            if kept:
                cleaned[area] = kept
        self.term_mastery_topics = cleaned
        return self

    @model_validator(mode="after")
    def _validate_lesson_resume(self):
        """One resume note per scheduled subject.

        A note for a subject the child isn't doing today can only confuse
        Bede's opener (it would never be read) or, worse, smuggle context
        into a subject the parent has since dropped — so those are filtered
        out here rather than trusted from the client. Duplicates collapse to
        the last one given, which is what a form that appends edits produces.
        """
        scheduled = set(self.subjects)
        by_subject: dict[Subject, LessonResume] = {}
        for entry in self.lesson_resume:
            if entry.subject in scheduled:
                by_subject[entry.subject] = entry
        self.lesson_resume = list(by_subject.values())
        return self


class VoiceNarrationPreferenceRequest(BaseModel):
    voice_narration_enabled: bool


class PodConfigsRequest(BaseModel):
    configs: List[SessionConfig] = Field(..., min_length=1, max_length=10)


class TutorRequest(BaseModel):
    session_config: SessionConfig
    current_subject: Subject
    conversation_history: List[ChatMessage] = []
    child_message: str = Field(..., min_length=1, max_length=2000)
    # Base64 PNG (no "data:image/..." prefix) from the handwriting canvas, sent to
    # Claude as an image so Bede reads the child's actual work instead of a text
    # placeholder. ~8MB base64 ceiling comfortably covers a canvas drawing.
    drawing_image: Optional[str] = Field(default=None, max_length=8_000_000)
    # The child's device clock at login, bucketed client-side (see
    # sessionStore.ts's deriveTimeOfDay) — the server has no reliable way to
    # know the child's timezone otherwise. None for older clients / the
    # sandbox, in which case Bede just doesn't adjust its greeting/prayer
    # framing for time of day.
    local_time_of_day: Optional[Literal["morning", "afternoon", "evening"]] = None


class NarrationUploadRequest(BaseModel):
    """A narration file exported from a smart pen/notebook app (e.g. inq) —
    see POST /tutor/extract-narration and services/document_extraction.py.
    No file is stored; extraction happens in memory for one request only."""
    filename: str = Field(..., min_length=1, max_length=200)
    content_base64: str = Field(..., min_length=1, max_length=7_000_000)


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)


class SandboxChatRequest(BaseModel):
    """
    Parent-only, direct-answer chat for testing/exploring Bede's behavior —
    see routers/sandbox.py. Nothing here is ever persisted: no DB writes, no
    narration assessments, no audit-logged content. sandbox_pin is checked
    on every request rather than once at login, since this doesn't have its
    own session/token — it rides on the parent's existing auth instead.
    """
    sandbox_pin: str = Field(..., min_length=1, max_length=100)
    conversation_history: List[ChatMessage] = []
    message: str = Field(..., min_length=1, max_length=4000)
    # The parent's own live-edited context/instructions for this conversation
    # only — never written to the real per-subject prompts or catalog files
    # that actually drive a child's tutoring session.
    custom_instructions: str = Field(default="", max_length=4000)


class SandboxDemoChatRequest(BaseModel):
    """
    Public-demo preview of the sandbox above — same shape minus sandbox_pin,
    since the demo role's own auth (DEMO_PIN + single-active-session) is the
    gate here instead. See routers/sandbox.py's /demo-chat.
    """
    conversation_history: List[ChatMessage] = []
    message: str = Field(..., min_length=1, max_length=4000)
    custom_instructions: str = Field(default="", max_length=4000)


class LoginRequest(BaseModel):
    role: Literal["parent", "child", "demo_code"]
    credential: str   # password for parent, PIN for child, generated code for demo_code
    # Chosen at the login screen itself (Login.tsx's English/Español toggle) —
    # per-login, not a per-student or deployment-wide setting. Validated
    # against core.config.SUPPORTED_LOCALES at the route (not here, to avoid
    # this module importing core.config) and embedded as a JWT claim, so the
    # rest of that session's requests carry it automatically via
    # core.deps.require_auth's returned payload. See services/ai_service.py's
    # _locale_directive and services/prayer_catalog.py for where it's read.
    locale: str = "en"


class DemoCodeRequest(BaseModel):
    """Optional personalization for a demo session — see POST /auth/demo-code.
    Both fields are optional; omitting either keeps the operator's configured
    DEMO_STUDENT_NAME/DEMO_GRADE default for that field. student_name is
    sanitized server-side (see routers/tutor.py's _demo_session_config) since
    it's the one new piece of free text an anonymous visitor can put in front
    of the model."""
    student_name: Optional[str] = Field(None, min_length=1, max_length=50)
    grade: Optional[str] = Field(None, max_length=2)


class DemoCodeResponse(BaseModel):
    """A freshly minted, one-time 6-digit code — see POST /auth/demo-code.
    Exchanged for a JWT via POST /auth/login (role="demo_code")."""
    code: str


class DiagnosticChatRequest(BaseModel):
    """Direct-answer chat for the demo's mastery-tracking preview — same
    shape as SandboxDemoChatRequest, reachable with the same demo_code
    token the child's own session already has (no separate login). See
    routers/diagnostic.py."""
    conversation_history: List[ChatMessage] = []
    message: str = Field(..., min_length=1, max_length=4000)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    # True when this token is only a "parent_pending" stepping-stone — the
    # parent's password was correct, but an enrolled security key/TOTP code
    # is still required before the real "parent" token is issued.
    mfa_required: bool = False
    mfa_methods: List[Literal["webauthn", "totp"]] = []


# ── Parent MFA: FIDO2 security key + TOTP ────────────────────────────────────

class WebAuthnRegisterVerifyRequest(BaseModel):
    credential: dict
    nickname: str = Field(default="", max_length=100)


class WebAuthnAuthVerifyRequest(BaseModel):
    credential: dict


class TotpConfirmRequest(BaseModel):
    code: str = Field(..., min_length=6, max_length=8)


class TotpVerifyRequest(BaseModel):
    code: str = Field(..., min_length=6, max_length=8)


class SessionSummaryRequest(BaseModel):
    session_config: SessionConfig
    conversation_history: List[ChatMessage]
    subjects_completed: List[Subject]
    duration_minutes: int


class EmailSummaryRequest(BaseModel):
    # Used for exactly one outbound send — never persisted anywhere, not the
    # database, not the audit log. See routers/tutor.py's /email-summary.
    email: EmailStr
    session_config: SessionConfig
    conversation_history: List[ChatMessage]
    subjects_completed: List[Subject]
    duration_minutes: int


class FeedbackRequest(BaseModel):
    """
    Beta feedback from any authenticated role (parent, child, or a public
    demo visitor) routed to the operator's own inbox — see routers/feedback.py.
    Nothing here is persisted server-side beyond the outbound email itself;
    the audit log records only that feedback was submitted, never its content
    or contact_email (same "never log the address" rule as email-summary).

    "plans" reuses this exact same pipeline for a different intent: a demo
    visitor asking about the full-featured version / monthly-annual plans
    (surfaced from the diagnostic preview's quota-exceeded state) rather
    than product feedback — same operator inbox (FEEDBACK_EMAIL), same
    one-outbound-email-and-nothing-persisted contract, just a different
    category label on the email subject so it's easy to triage at a glance.

    "beta_close" is the demo's own end-of-session "help us improve" prompt
    (DemoSummaryScreen, demo/src/App.tsx) — contact_email here is opt-in and
    explicitly gated behind a parent/guardian affirmation client-side before
    the field is even shown, since unlike the rest of this endpoint's
    traffic, a volunteered email address is unambiguous personal
    information, not an anonymized signal.
    """
    category: Literal["cx", "ux", "content_quality", "plans", "other", "beta_close"]
    message: str = Field(..., min_length=1, max_length=2000)
    rating: Optional[int] = Field(None, ge=1, le=5)
    contact_email: Optional[EmailStr] = None


class NarrationRecord(BaseModel):
    subject: Subject
    narration_text: str
    timestamp: str


# ── Narration assessment (Phase 1 — mastery engine) ───────────────────────────

class TriviumStage(str, Enum):
    grammar  = "grammar"    # K-5: absorption, story, wonder
    logic    = "logic"      # 6-8: questioning, patterns, cause-effect
    rhetoric = "rhetoric"   # 9-12: synthesis, argument, application

class ProcessingStyle(str, Enum):
    visual         = "visual"          # rich imagery, spatial language
    auditory       = "auditory"        # rhythm, sound, music references
    reading_writing = "reading_writing" # precise quotes, careful language
    kinesthetic    = "kinesthetic"     # action, movement, hands-on focus

class NarrationMode(str, Enum):
    sequential  = "sequential"   # retells in careful chronological order
    associative = "associative"  # jumps to significance, makes cross-leaps

class NarrationAssessmentData(BaseModel):
    """Full rubric data stored encrypted per narration event."""
    subject:                str
    completeness:           int = Field(..., ge=1, le=5)
    sequence:               int = Field(..., ge=1, le=5)
    detail:                 int = Field(..., ge=1, le=5)
    language_quality:       int = Field(..., ge=1, le=5)
    synthesis:              int = Field(..., ge=1, le=5)
    total_score:            int = Field(..., ge=5, le=25)
    concepts_demonstrated:  List[str]
    misconceptions:         List[str]
    adaptive_signal:        Literal["advance", "repeat", "review_prerequisite"]
    bede_observation:       str
    assessed_at:            str

class LearnerProfileData(BaseModel):
    """Stable learner-type profile synthesized from accumulated assessments."""
    trivium_stage:         TriviumStage
    processing_style:      ProcessingStyle
    narration_mode:        NarrationMode
    attention_profile:     Literal["short_blocks", "sustained", "variable"]
    session_count_assessed: int
    bede_profile_notes:    str
    assessed_at:           str

# ── Diagnostic engine (mastery profile) ──────────────────────────────────────

class MasteryLevel(str, Enum):
    gap        = "gap"          # P(mastery) < 0.4
    developing = "developing"   # 0.4 <= P < 0.8
    secure     = "secure"       # P >= 0.8

class SkillMasteryView(BaseModel):
    """One sub-skill's rolled-up view for the parent dashboard."""
    skill_id:     str
    label:        str
    domain:       str
    grade_band:   str
    probability:  float = Field(..., ge=0.0, le=1.0)
    level:        MasteryLevel

class DomainMasteryView(BaseModel):
    domain:              str
    average_probability: float = Field(..., ge=0.0, le=1.0)
    level:               MasteryLevel
    skills:              List[SkillMasteryView]

class MasteryProfileSummary(BaseModel):
    """Render-only parent summary. No raw evidence, no transcript."""
    student_name:   str
    subject_area:   str = "mathematics"
    evidence_count: int
    calibration:    bool                       # still in cold-start widening phase
    domains:        List[DomainMasteryView]
    gaps:           List[SkillMasteryView]     # level == gap, worst first
    next_steps:     List[SkillMasteryView]     # KST fringe — learnable now
    updated_at:     str

class ModelUsage(BaseModel):
    """One model's token totals within a UsageSummary — see core/api_usage.py."""
    model:                  str
    input_tokens:           int
    output_tokens:          int
    cache_creation_tokens:  int
    cache_read_tokens:      int
    calls:                  int
    estimated_cost_usd:     float

class UsageSummary(BaseModel):
    """
    Best-effort Anthropic API token/cost estimate for this BYOK deployment
    — never a bill, console.anthropic.com is the authoritative source.
    student_name is None for the household-wide total (GET /admin/status);
    set to a specific student's name for the per-student breakdown
    (GET /admin/usage/{student_name}).
    """
    student_name:         Optional[str] = None
    total_input_tokens:   int
    total_output_tokens:  int
    total_calls:          int
    estimated_cost_usd:   float
    by_model:             List[ModelUsage]

class RecordSkillEvidenceInput(BaseModel):
    """Server-side validation of the silent record_skill_evidence tool's
    input (Phase 3). Never leaves the server; not part of any response body."""
    probe_id:   str = Field(..., max_length=80)
    outcome:    Literal["correct", "partial", "incorrect", "hint_dependent"]
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
