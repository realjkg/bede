import { Sun, BookOpen, Calculator, Leaf, Globe, PenLine, FlaskConical, Palette, Star, Sparkles } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type GradeStage = 'K-2' | '3-5' | '6-8'

export type Subject =
  | 'morning_time'
  | 'living_books'
  | 'mathematics'
  | 'nature_study'
  | 'history'
  | 'language_arts'
  | 'science'
  | 'art_music'
  | 'saints'
  | 'free_study'

export interface SessionConfig {
  student_name: string
  grade: string
  grade_stage: GradeStage
  // Biological sex, not "gender identity" — see models/schemas.py's
  // SessionConfig.sex on the backend. Unused/optional on an English-only
  // deployment; required by POST /pod/configs once the deployment's LOCALE
  // is a grammatically gendered language (Spanish, Italian, Polish so far)
  // so Bede can address the student correctly. See docs/LOCALIZATION.md.
  sex?: 'male' | 'female'
  subjects: Subject[]
  lesson_focus?: string
  faith_emphasis?: string
  current_unit?: string
  voice_required?: boolean  // false for mute students — PIN-only auth, no voice passphrase
  // The session's hard stop, in minutes — on by default and there by design
  // (2-hour default, 4-hour maximum; absent = 2 hours, and gradeTimer.ts's
  // effectiveSessionCap clamps whatever is stored). The session concludes
  // automatically when it's reached, and a mandatory 10-minute break runs
  // after every hour of session time regardless of this value.
  session_cap_minutes?: number
  // Parent-set cap on total on-screen tutoring minutes before a mandatory eye-rest
  // break is inserted. null/undefined = no cap beyond the normal grade-based
  // block/break cycle in gradeTimer.ts.
  screen_time_limit_minutes?: number | null
  // Length of the mandatory break once screen_time_limit_minutes is reached.
  // Floor of 30 is enforced in gradeTimer.ts regardless of what's stored here.
  eye_rest_break_minutes?: number
  // Remembers the child's own last choice for Bede's spoken narration (the
  // mute/unmute button in SocraticChat.tsx) — distinct from voice_required
  // above, which is about login voice-biometric verification, not TTS
  // output. Defaults true when absent (configs saved before this field existed).
  voice_narration_enabled?: boolean
  // Parent-side lock on the chat appearance picker (background theme +
  // bubble color). True hides the picker in the child's session — the
  // device keeps whatever look it already has; a parent-role session
  // still sees it. Defaults false/absent for configs saved before this
  // field existed.
  appearance_locked?: boolean
  // ── Term schedule & outcomes ────────────────────────────────────────────
  // Mater Amabilis default is a 3-term (trimester) year; quarterly gives 4.
  term_schedule?: TermSchedule
  current_term?: number
  // Parent's mastery outcomes for the current term: up to 3 topics per core
  // area (keys from CORE_AREAS). Exposure to all is expected across the
  // term; mastery of these named topics is the outcome. Bede records
  // per-topic evidence via assess_narration (term_topic fields below).
  term_mastery_topics?: Partial<Record<CoreArea, string[]>>
  // "Meet me where I am" — the parent's note about where an interrupted
  // lesson stopped, so Bede opens that subject mid-thread instead of
  // introducing it fresh (and without asking the child where they got to).
  // At most one entry per subject, and only for subjects in `subjects`
  // above — the backend drops anything else (models/schemas.py's
  // SessionConfig._validate_lesson_resume).
  lesson_resume?: LessonResume[]
}

// Mirrors homeschool-api/models/schemas.py's LessonResume. `subject` is a
// Subject, not free text: a resume note can only ever point at one of the
// subjects Bede already teaches, never introduce a new topic of its own.
export interface LessonResume {
  subject: Subject
  stopped_at: string
  next_step?: string
  sticking_point?: string
  recorded_on?: string  // ISO YYYY-MM-DD
}

export type TermSchedule = 'trimester' | 'quarterly'

// Foundational core areas tracked term-by-term — mirrors
// homeschool-api/models/schemas.py CORE_AREAS.
export type CoreArea =
  | 'phonics_language'
  | 'mathematics'
  | 'reading_literature'
  | 'science'
  | 'writing_composition'

export const CORE_AREAS: Array<{ id: CoreArea; label: string }> = [
  { id: 'phonics_language',    label: 'Phonics & Language' },
  { id: 'mathematics',         label: 'Math' },
  { id: 'reading_literature',  label: 'Reading & Literature' },
  { id: 'science',             label: 'Science' },
  { id: 'writing_composition', label: 'Writing & Composition' },
]

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface VisualAidData {
  id: string
  title: string
  creator: string
  year: string
  wiki_title: string
  description: string
  category: string
}

export interface StreamChunk {
  type: 'text' | 'tool' | 'done' | 'assessment' | 'visual_aid' | 'subject_complete'
  content?: string
  tool?: string
  reason?: 'mastery' | 'frustration'
  data?: { subject: string; total_score: number; adaptive_signal: string }
  visualAid?: VisualAidData
}

export interface SubjectInfo {
  id: Subject
  label: string
  Icon: LucideIcon
  durationMin: number
  color: string
  description: string
}

export const SUBJECTS: SubjectInfo[] = [
  {
    id: 'morning_time',
    label: 'Morning Time',
    Icon: Sun,
    durationMin: 20,
    color: 'bg-amber-50 border-amber-200 text-amber-800',
    description: 'Bible, hymn, poetry & prayer',
  },
  {
    id: 'living_books',
    label: 'Living Books',
    Icon: BookOpen,
    durationMin: 25,
    color: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    description: 'Classical literature & narration',
  },
  {
    id: 'mathematics',
    label: 'Mathematics',
    Icon: Calculator,
    durationMin: 20,
    color: 'bg-blue-50 border-blue-200 text-blue-800',
    description: 'Discovery-based mathematical thinking',
  },
  {
    id: 'nature_study',
    label: 'Nature Study',
    Icon: Leaf,
    durationMin: 20,
    color: 'bg-green-50 border-green-200 text-green-800',
    description: 'Observation, wonder & creation',
  },
  {
    id: 'history',
    label: 'History & Geography',
    Icon: Globe,
    durationMin: 20,
    color: 'bg-orange-50 border-orange-200 text-orange-800',
    description: 'Story-based history & real places',
  },
  {
    id: 'language_arts',
    label: 'Language Arts',
    Icon: PenLine,
    durationMin: 15,
    color: 'bg-purple-50 border-purple-200 text-purple-800',
    description: 'Narration, copywork & grammar',
  },
  {
    id: 'science',
    label: 'Science',
    Icon: FlaskConical,
    durationMin: 20,
    color: 'bg-teal-50 border-teal-200 text-teal-800',
    description: 'Botany, zoology & earth science',
  },
  {
    id: 'art_music',
    label: 'Art & Music',
    Icon: Palette,
    durationMin: 15,
    color: 'bg-rose-50 border-rose-200 text-rose-800',
    description: 'Composer & artist study',
  },
  {
    id: 'saints',
    label: 'Saints & Catechism',
    Icon: Star,
    durationMin: 15,
    color: 'bg-gold-50 border-gold-200 text-gold-700',
    description: 'Saints, catechism & virtue formation',
  },
  {
    id: 'free_study',
    label: 'Free Study',
    Icon: Sparkles,
    durationMin: 20,
    color: 'bg-yellow-50 border-yellow-200 text-yellow-800',
    description: 'Student-directed exploration',
  },
]

export const SUBJECT_MAP: Record<Subject, SubjectInfo> = Object.fromEntries(
  SUBJECTS.map((s) => [s.id, s])
) as Record<Subject, SubjectInfo>

export interface NarrationAssessmentData {
  subject: string
  completeness: number
  sequence: number
  detail: number
  language_quality: number
  synthesis: number
  total_score: number
  concepts_demonstrated: string[]
  misconceptions: string[]
  adaptive_signal: 'advance' | 'repeat' | 'review_prerequisite'
  bede_observation: string
  assessed_at: string
  // Term-outcome evidence — present only when the exchange demonstrated one
  // of the parent's term mastery topics (see SessionConfig.term_mastery_topics).
  term_topic?: string | null
  term_topic_level?: 'introduced' | 'developing' | 'mastered' | null
}

export interface LearnerProfileData {
  trivium_stage: 'grammar' | 'logic' | 'rhetoric'
  processing_style: 'visual' | 'auditory' | 'reading_writing' | 'kinesthetic'
  narration_mode: 'sequential' | 'associative'
  attention_profile: 'short_blocks' | 'sustained' | 'variable'
  session_count_assessed: number
  bede_profile_notes: string
  assessed_at: string
}

// Parent-only (unlike LearnerProfileData, which a child token can also
// read) — see homeschool-api/core/database.py's LearnerBehaviorCheck for
// what this is and isn't. Only ever present while processing_style is
// currently one of the three TRACKABLE_STYLES (kinesthetic, reading_writing,
// visual — see routers/narration.py); null otherwise, including for
// auditory, which gets a prompt nudge but no counter (no honest tool-level
// signal exists for it). Deliberately NOT a claim that any of these labels
// improves learning — only a check that Bede's own prompted adaptation is
// actually happening. count's meaning depends on the CURRENT
// processing_style (see behaviorCheckLine in pages/Progress.tsx).
export interface LearnerBehaviorCheck {
  count: number
  since: string
}

// Real, persisted (mastery_profiles) diagnostic summary — see
// homeschool-api/services/diagnostic/get_mastery_summary. Same shape as
// the public demo's own preview (demo/src/api.ts's MasteryProfileSummary),
// but this one reflects the student's whole history, not one session.
export type MasteryLevel = 'gap' | 'developing' | 'secure'

export interface SkillMasteryView {
  skill_id: string
  label: string
  domain: string
  grade_band: string
  probability: number
  level: MasteryLevel
}

export interface DomainMasteryView {
  domain: string
  average_probability: number
  level: MasteryLevel
  skills: SkillMasteryView[]
}

export interface MasteryProfileSummary {
  student_name: string
  subject_area: string
  evidence_count: number
  calibration: boolean
  domains: DomainMasteryView[]
  gaps: SkillMasteryView[]
  next_steps: SkillMasteryView[]
  updated_at: string
}

// Best-effort Anthropic API token/cost estimate for this BYOK deployment
// (see homeschool-api/core/api_usage.py) — never a bill, console.anthropic.com
// is the authoritative source. student_name is null for the household-wide
// total (GET /admin/status); set for a specific student's own breakdown
// (GET /admin/usage/{student_name}).
export interface ModelUsage {
  model: string
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  calls: number
  estimated_cost_usd: number
}

export interface UsageSummary {
  student_name: string | null
  total_input_tokens: number
  total_output_tokens: number
  total_calls: number
  estimated_cost_usd: number
  by_model: ModelUsage[]
}

// Mirrors homeschool-api/core/licensing.py's LicenseInfo, as surfaced by
// GET /admin/status. Null on the wire (see routers/admin.py) when
// LICENSE_KEY is unset — dev/self-managed mode, or the operator's public
// demo (Settings.is_demo_deployment exempts it from needing one). A real
// family production deployment always has one (core/config.py refuses to
// boot without a valid one there), so this is effectively always present
// for that case.
export interface LicenseStatus {
  tier: 'trial' | 'core' | 'coop'
  licensee: string
  seats: number
  expires: string | null
  days_remaining: number | null
  is_expired: boolean
}
