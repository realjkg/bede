import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation, Trans } from 'react-i18next'
import { Plus, Trash2, Mic, CheckCircle, ChevronDown, ChevronUp, Database, Shield, Users, Loader2, DollarSign, KeyRound, AlertTriangle, BookMarked, X } from 'lucide-react'
import { useSessionStore } from '../store/sessionStore'
import type { Subject, GradeStage, SessionConfig, TermSchedule, CoreArea, LessonResume } from '../types'
import { SUBJECTS, SUBJECT_MAP, CORE_AREAS } from '../types'
import VoiceEnrollment from '../components/VoiceEnrollment'
import ParentSecuritySettings from '../components/ParentSecuritySettings'
import { listVoiceProfiles } from '../services/voiceApi'
import { fetchSystemStatus, listPodConfigs, savePodConfigs, type SystemStatus } from '../services/api'

// label is a numeric grade range, not a translated word — same across
// locales. descriptionKey resolves through i18n at render time since this
// array is module-level (no hook context to call t() here directly).
const GRADE_STAGES: Array<{ label: string; value: GradeStage; descriptionKey: string; emoji: string }> = [
  { label: 'K–2', value: 'K-2', descriptionKey: 'parentSetup.stageDescGrammar', emoji: '🌱' },
  { label: '3–5', value: '3-5', descriptionKey: 'parentSetup.stageDescLogic', emoji: '🔭' },
  { label: '6–8', value: '6-8', descriptionKey: 'parentSetup.stageDescRhetoric', emoji: '🎓' },
]

// One "pick up where we left off" row in the form. `subject` is '' until the
// parent picks one, and the picker only ever offers subjects already
// selected for this student — a resume note can never introduce a topic
// outside what Bede teaches (the backend enforces the same thing; see
// models/schemas.py's SessionConfig._validate_lesson_resume).
interface ResumeForm {
  subject: Subject | ''
  stopped_at: string
  next_step: string
  sticking_point: string
  recorded_on: string
}

const blankResume = (): ResumeForm => ({
  subject: '',
  stopped_at: '',
  next_step: '',
  sticking_point: '',
  recorded_on: '',
})

interface StudentForm {
  student_name: string
  grade: string
  grade_stage: GradeStage
  // Biological sex, not "gender identity" — see types/index.ts's
  // SessionConfig.sex. '' means unset; only required when systemStatus's
  // locale is a grammatically gendered language (see requireSex below).
  sex: '' | 'male' | 'female'
  selected_subjects: Subject[]
  lesson_focus: string
  faith_emphasis: string
  current_unit: string
  voice_required: boolean
  appearance_locked: boolean
  session_cap_minutes: number
  screen_time_limit_enabled: boolean
  screen_time_limit_minutes: number
  eye_rest_break_minutes: number
  term_schedule: TermSchedule
  current_term: number
  // Comma-separated per area in the form; parsed to string[] on save.
  term_topics: Record<CoreArea, string>
  // Where each interrupted subject left off — see ResumeForm above.
  lesson_resume: ResumeForm[]
  // Not editable here: this is the child's own mute/unmute choice for
  // Bede's narration (PATCH /pod/configs/{name}/voice-narration). Carried
  // through the form only so re-saving the pod doesn't silently reset it.
  voice_narration_enabled: boolean
  expandedContext: boolean
  showEnrollment: boolean
}

const blankStudent = (): StudentForm => ({
  student_name: '',
  grade: '',
  grade_stage: '3-5',
  sex: '',
  selected_subjects: SUBJECTS.filter((s) => s.id !== 'free_study').map((s) => s.id),
  lesson_focus: '',
  faith_emphasis: '',
  current_unit: '',
  voice_required: true,
  appearance_locked: false,
  session_cap_minutes: 120,
  screen_time_limit_enabled: false,
  screen_time_limit_minutes: 90,
  eye_rest_break_minutes: 30,
  term_schedule: 'trimester',
  current_term: 1,
  term_topics: {
    phonics_language: '', mathematics: '', reading_literature: '',
    science: '', writing_composition: '',
  },
  lesson_resume: [],
  voice_narration_enabled: true,
  expandedContext: false,
  showEnrollment: false,
})

// Rebuilds the form from a config already saved on the server, so a parent
// coming back the next day edits their existing plan — and last session's
// resume notes — instead of retyping the pod from a blank page.
const formFromConfig = (c: SessionConfig): StudentForm => {
  const blank = blankStudent()
  return {
    ...blank,
    student_name: c.student_name,
    grade: c.grade,
    grade_stage: c.grade_stage,
    sex: c.sex ?? '',
    selected_subjects: c.subjects,
    lesson_focus: c.lesson_focus ?? '',
    faith_emphasis: c.faith_emphasis ?? '',
    current_unit: c.current_unit ?? '',
    voice_required: c.voice_required ?? true,
    appearance_locked: c.appearance_locked ?? false,
    session_cap_minutes: c.session_cap_minutes ?? 120,
    screen_time_limit_enabled: c.screen_time_limit_minutes != null,
    screen_time_limit_minutes: c.screen_time_limit_minutes ?? 90,
    eye_rest_break_minutes: c.eye_rest_break_minutes ?? 30,
    term_schedule: c.term_schedule ?? 'trimester',
    current_term: c.current_term ?? 1,
    term_topics: {
      ...blank.term_topics,
      ...Object.fromEntries(
        CORE_AREAS.map(({ id }) => [id, (c.term_mastery_topics?.[id] ?? []).join(', ')]),
      ),
    },
    lesson_resume: (c.lesson_resume ?? []).map((r) => ({
      subject: r.subject,
      stopped_at: r.stopped_at,
      next_step: r.next_step ?? '',
      sticking_point: r.sticking_point ?? '',
      recorded_on: r.recorded_on ?? '',
    })),
    voice_narration_enabled: c.voice_narration_enabled ?? true,
    // Already-filled context shouldn't hide behind a collapsed toggle.
    expandedContext: !!(c.lesson_focus || c.faith_emphasis || c.current_unit),
  }
}

export default function ParentSetup() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { setSessionConfig, startSession, setPodStudents, logout, token } = useSessionStore()

  const [students, setStudents] = useState<StudentForm[]>([blankStudent()])
  const [enrolledProfiles, setEnrolledProfiles] = useState<string[]>([])
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [hitlConsent, setHitlConsent] = useState(false)

  useEffect(() => {
    if (!token) return
    listVoiceProfiles(token).then(setEnrolledProfiles).catch(() => {})
    fetchSystemStatus(token)
      .then(setSystemStatus)
      .catch(() => setStatusError(true))
    // Load the pod the parent already saved, so this page opens on their
    // existing plan (resume notes included) rather than a blank form. The
    // functional update is the guard against clobbering anything typed
    // while the request was in flight; failure just leaves the blank form.
    listPodConfigs(token)
      .then((configs) => {
        if (!configs.length) return
        setStudents((prev) =>
          prev.length === 1 && !prev[0].student_name.trim() && !prev[0].grade.trim()
            ? configs.map(formFromConfig)
            : prev,
        )
      })
      .catch(() => {})
  }, [token])

  const isEnrolled = (name: string) =>
    enrolledProfiles.some((p) => p.toLowerCase() === name.toLowerCase())

  const update = (i: number, patch: Partial<StudentForm>) =>
    setStudents((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))

  const toggleSubject = (i: number, id: Subject) => {
    const s = students[i]
    update(i, {
      selected_subjects: s.selected_subjects.includes(id)
        ? s.selected_subjects.filter((x) => x !== id)
        : [...s.selected_subjects, id],
    })
  }

  const addStudent = () => setStudents((prev) => [...prev, blankStudent()])
  const removeStudent = (i: number) =>
    setStudents((prev) => prev.filter((_, idx) => idx !== i))

  // Every locale this deployment currently supports (Spanish, Italian,
  // Polish) is a grammatically gendered language, so a non-English locale
  // means Bede needs to know each student's sex to address them correctly
  // — see docs/LOCALIZATION.md. An English-only deployment never asks.
  const requireSex = !!systemStatus?.locale && systemStatus.locale !== 'en'

  const canSave =
    hitlConsent &&
    students.length > 0 &&
    students.every((s) =>
      s.student_name.trim() && s.grade.trim() && s.selected_subjects.length > 0 &&
      (!requireSex || s.sex)
    )

  const handleSavePod = async () => {
    if (!canSave || !token) return
    setSaving(true)
    setSaveError('')
    const configs: SessionConfig[] = students.map((s) => ({
      student_name: s.student_name.trim(),
      grade: s.grade.trim(),
      grade_stage: s.grade_stage,
      sex: s.sex || undefined,
      subjects: s.selected_subjects,
      lesson_focus: s.lesson_focus.trim() || undefined,
      faith_emphasis: s.faith_emphasis.trim() || undefined,
      current_unit: s.current_unit.trim() || undefined,
      voice_required: s.voice_required,
      appearance_locked: s.appearance_locked,
      session_cap_minutes: Math.max(30, Math.min(240, s.session_cap_minutes)),
      screen_time_limit_minutes: s.screen_time_limit_enabled ? s.screen_time_limit_minutes : null,
      eye_rest_break_minutes: Math.max(30, s.eye_rest_break_minutes),
      term_schedule: s.term_schedule,
      current_term: Math.min(s.current_term, s.term_schedule === 'trimester' ? 3 : 4),
      term_mastery_topics: Object.fromEntries(
        CORE_AREAS.map(({ id }) => [
          id,
          s.term_topics[id].split(',').map((t) => t.trim()).filter(Boolean).slice(0, 3),
        ]).filter(([, topics]) => (topics as string[]).length > 0),
      ),
      voice_narration_enabled: s.voice_narration_enabled,
      // Only complete rows for a subject this student is actually doing
      // today — a half-filled row is dropped rather than saved as an empty
      // resume note. The backend re-checks both (schemas.py).
      lesson_resume: s.lesson_resume
        .filter((r): r is ResumeForm & { subject: Subject } =>
          !!r.subject && !!r.stopped_at.trim() && s.selected_subjects.includes(r.subject as Subject))
        .map((r): LessonResume => ({
          subject: r.subject,
          stopped_at: r.stopped_at.trim().slice(0, 300),
          next_step: r.next_step.trim().slice(0, 300) || undefined,
          sticking_point: r.sticking_point.trim().slice(0, 300) || undefined,
          recorded_on: r.recorded_on || undefined,
        })),
    }))
    try {
      await savePodConfigs(token, configs)
      setPodStudents(configs)
      // Single-student shortcut: start session directly
      if (configs.length === 1) {
        setSessionConfig(configs[0])
        startSession()
        navigate('/session')
      } else {
        navigate('/pod')
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('parentSetup.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-parchment-50 via-parchment-50 to-navy-50/40 p-4 md:p-8">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <div className="flex items-center gap-3">
              <img src="/bede-icon.webp" alt="Bede" className="w-9 h-9 rounded-full object-cover" />
              <h1 className="text-2xl font-display font-bold text-gray-800">{t('parentSetup.title')}</h1>
            </div>
            <p className="text-sm text-gray-500 mt-1">{t('parentSetup.subtitle')}</p>
          </div>
          <button onClick={logout} className="text-xs text-gray-400 hover:text-gray-600 underline">
            {t('parentSetup.logOut')}
          </button>
        </div>

        {/* System status */}
        <div className={`rounded-xl border px-4 py-3 mb-6 flex items-center gap-4 flex-wrap text-xs ${
          statusError
            ? 'border-red-200 bg-red-50 text-red-700'
            : systemStatus
            ? 'border-green-200 bg-green-50 text-green-800'
            : 'border-gray-200 bg-gray-50 text-gray-500'
        }`}>
          {statusError ? (
            <span className="flex items-center gap-1.5"><Database size={13} /> {t('parentSetup.cannotReachServer')}</span>
          ) : systemStatus ? (
            <>
              <span className="flex items-center gap-1.5 font-medium"><Database size={13} /> {t('parentSetup.dbConnected')}</span>
              <span className="flex items-center gap-1.5"><Shield size={13} /> {systemStatus.encryption}</span>
              <span className="flex items-center gap-1.5">
                <Users size={13} />
                {systemStatus.voice_profiles_enrolled === 0
                  ? t('parentSetup.noVoicesEnrolled')
                  : t('parentSetup.voicesEnrolled', { count: systemStatus.voice_profiles_enrolled })}
              </span>
              <span className="flex items-center gap-1.5" title={t('parentSetup.usageEstimateTooltip')}>
                <DollarSign size={13} />
                {t('parentSetup.usageEstimate', { cost: systemStatus.usage.estimated_cost_usd.toFixed(2) })}
              </span>
              {systemStatus.license && (
                <span
                  className={`flex items-center gap-1.5 ${
                    systemStatus.license.tier === 'trial' &&
                    systemStatus.license.days_remaining !== null &&
                    systemStatus.license.days_remaining <= 7
                      ? 'text-amber-700 font-medium'
                      : ''
                  }`}
                  title={t('parentSetup.licenseTooltip', { licensee: systemStatus.license.licensee, seats: systemStatus.license.seats })}
                >
                  {systemStatus.license.tier === 'trial' &&
                  systemStatus.license.days_remaining !== null &&
                  systemStatus.license.days_remaining <= 7 ? (
                    <AlertTriangle size={13} />
                  ) : (
                    <KeyRound size={13} />
                  )}
                  {systemStatus.license.tier === 'trial'
                    ? systemStatus.license.days_remaining !== null && systemStatus.license.days_remaining >= 0
                      ? t('parentSetup.trialDaysLeft', { count: systemStatus.license.days_remaining })
                      : t('parentSetup.trialExpired')
                    : systemStatus.license.tier === 'coop' ? t('parentSetup.coopLicense') : t('parentSetup.coreLicense')}
                </span>
              )}
            </>
          ) : (
            <span>{t('parentSetup.checkingStatus')}</span>
          )}
        </div>

        <ParentSecuritySettings token={token!} />

        {/* Student cards */}
        <div className="space-y-4">
          {students.map((student, i) => (
            <StudentCard
              key={i}
              index={i}
              student={student}
              total={students.length}
              isEnrolled={isEnrolled(student.student_name.trim())}
              token={token!}
              requireSex={requireSex}
              onUpdate={(patch) => update(i, patch)}
              onToggleSubject={(id) => toggleSubject(i, id)}
              onEnrolled={() => listVoiceProfiles(token!).then(setEnrolledProfiles).catch(() => {})}
              onRemove={() => removeStudent(i)}
            />
          ))}
        </div>

        {/* Add student */}
        {students.length < 8 && (
          <button
            onClick={addStudent}
            className="mt-4 w-full py-3 border-2 border-dashed border-navy-300 rounded-xl text-navy-600 hover:border-navy-400 hover:bg-navy-50 transition-colors flex items-center justify-center gap-2 text-sm font-medium"
          >
            <Plus size={16} /> {t('parentSetup.addAnotherStudent')}
          </button>
        )}

        {/* Parent HITL consent acknowledgment */}
        <label className="mt-6 flex items-start gap-3 cursor-pointer group">
          <input
            type="checkbox"
            checked={hitlConsent}
            onChange={(e) => setHitlConsent(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-navy-600 flex-shrink-0"
          />
          <span className="text-xs text-gray-600 leading-relaxed">
            <Trans i18nKey="parentSetup.hitlConsent" components={{ strong: <strong /> }} />
          </span>
        </label>

        {/* Save */}
        {saveError && (
          <p className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {saveError}
          </p>
        )}
        <button
          onClick={handleSavePod}
          disabled={!canSave || saving}
          className="mt-6 w-full py-4 bg-navy-500 text-white rounded-xl font-semibold text-base hover:bg-navy-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          {saving ? (
            <><Loader2 size={18} className="animate-spin" /> {t('parentSetup.saving')}</>
          ) : students.length === 1 ? (
            <>{t('parentSetup.beginSession')}</>
          ) : (
            <>{t('parentSetup.openPodDashboard', { count: students.length })}</>
          )}
        </button>
      </div>
    </div>
  )
}

interface StudentCardProps {
  index: number
  student: StudentForm
  total: number
  isEnrolled: boolean
  token: string
  requireSex: boolean
  onUpdate: (patch: Partial<StudentForm>) => void
  onToggleSubject: (id: Subject) => void
  onEnrolled: () => void
  onRemove: () => void
}

function StudentCard({
  index, student, total, isEnrolled, token, requireSex,
  onUpdate, onToggleSubject, onEnrolled, onRemove,
}: StudentCardProps) {
  const { t } = useTranslation()
  const totalMin = student.selected_subjects.reduce((acc, s) => {
    const info = SUBJECTS.find((x) => x.id === s)
    return acc + (info?.durationMin ?? 0)
  }, 0)

  const label = student.student_name.trim() || t('parentSetup.studentFallbackLabel', { n: index + 1 })

  const addResume = () => onUpdate({ lesson_resume: [...student.lesson_resume, blankResume()] })
  const removeResume = (ri: number) =>
    onUpdate({ lesson_resume: student.lesson_resume.filter((_, k) => k !== ri) })
  const updateResume = (ri: number, patch: Partial<ResumeForm>) =>
    onUpdate({
      lesson_resume: student.lesson_resume.map((r, k) => (k === ri ? { ...r, ...patch } : r)),
    })

  return (
    <div className="bg-white rounded-xl border border-navy-100 shadow-sm overflow-hidden">
      {/* Card header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
        <div className="w-8 h-8 rounded-full bg-navy-100 flex items-center justify-center text-navy-700 font-semibold text-sm flex-shrink-0">
          {index + 1}
        </div>
        <span className="font-semibold text-gray-800 flex-1 truncate">{label}</span>
        {total > 1 && (
          <button
            onClick={onRemove}
            className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
            title={t('parentSetup.removeStudent')}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      <div className="p-5 space-y-5">
        {/* Name + grade */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">{t('parentSetup.studentsName')}</label>
            <input
              type="text"
              value={student.student_name}
              onChange={(e) => onUpdate({ student_name: e.target.value })}
              placeholder={t('parentSetup.namePlaceholder')}
              className="input"
            />
          </div>
          <div>
            <label className="label">{t('parentSetup.grade')}</label>
            <input
              type="text"
              value={student.grade}
              onChange={(e) => onUpdate({ grade: e.target.value })}
              placeholder={t('parentSetup.gradePlaceholder')}
              className="input"
            />
          </div>
        </div>

        {/* Grade stage */}
        <div className="grid grid-cols-3 gap-2">
          {GRADE_STAGES.map((s) => (
            <button
              key={s.value}
              onClick={() => onUpdate({ grade_stage: s.value })}
              className={`rounded-xl border-2 p-2.5 text-left transition-all ${
                student.grade_stage === s.value
                  ? 'border-navy-500 bg-navy-50'
                  : 'border-gray-200 bg-white hover:border-navy-200'
              }`}
            >
              <div className="text-lg mb-0.5">{s.emoji}</div>
              <div className="font-semibold text-xs text-gray-800">{s.label}</div>
              <div className="text-xs text-gray-400 leading-tight">{t(s.descriptionKey)}</div>
            </button>
          ))}
        </div>

        {/* Sex — only asked when the deployment's locale needs it for
            grammatically correct address (Spanish, Italian, Polish so far;
            an English-only deployment never sees this). */}
        {requireSex && (
          <div>
            <label className="label">{t('parentSetup.sex')}</label>
            <div className="grid grid-cols-2 gap-2">
              {(['male', 'female'] as const).map((value) => (
                <button
                  key={value}
                  onClick={() => onUpdate({ sex: value })}
                  className={`rounded-xl border-2 py-2.5 text-sm font-medium transition-all ${
                    student.sex === value
                      ? 'border-navy-500 bg-navy-50 text-navy-800'
                      : 'border-gray-200 bg-white text-gray-600 hover:border-navy-200'
                  }`}
                >
                  {value === 'male' ? t('parentSetup.sexMale') : t('parentSetup.sexFemale')}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-1.5">
              {student.student_name.trim()
                ? t('parentSetup.sexHelpNamed', { name: student.student_name.trim() })
                : t('parentSetup.sexHelpUnnamed')}
            </p>
          </div>
        )}

        {/* Subjects */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label mb-0">{t('parentSetup.subjects')}</label>
            <span className="text-xs text-gray-400">{t('parentSetup.minutesShort', { count: totalMin })}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {SUBJECTS.map((s) => {
              const active = student.selected_subjects.includes(s.id)
              return (
                <button
                  key={s.id}
                  onClick={() => onToggleSubject(s.id)}
                  className={`flex items-center gap-2 rounded-xl border-2 px-3 py-2 text-left transition-all hover:scale-[1.03] active:scale-[0.97] ${
                    active ? 'border-navy-400 bg-navy-50 shadow-sm' : 'border-gray-200 bg-white opacity-50'
                  }`}
                >
                  <s.Icon size={16} className="flex-shrink-0 text-current" />
                  <div>
                    <div className="text-xs font-medium text-gray-800">{s.label}</div>
                    <div className="text-xs text-gray-400">{t('parentSetup.minutesShort', { count: s.durationMin })}</div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Voice / accessibility */}
        <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
          <div>
            <p className="text-sm font-medium text-gray-700">{t('parentSetup.voiceVerification')}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {student.voice_required
                ? t('parentSetup.voiceVerificationOn')
                : t('parentSetup.voiceVerificationOff')}
            </p>
          </div>
          <button
            onClick={() => onUpdate({ voice_required: !student.voice_required })}
            className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
              student.voice_required ? 'bg-navy-500' : 'bg-gray-300'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                student.voice_required ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Appearance lock — hides the chat theme/bubble picker in this
            student's sessions. For children who find open-ended
            customization a distraction magnet, choice happens here with
            the parent, not mid-lesson. */}
        <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
          <div>
            <p className="text-sm font-medium text-gray-700">{t('parentSetup.lockChatAppearance')}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {student.appearance_locked
                ? t('parentSetup.appearanceLockedOn')
                : t('parentSetup.appearanceLockedOff')}
            </p>
          </div>
          <button
            onClick={() => onUpdate({ appearance_locked: !student.appearance_locked })}
            className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
              student.appearance_locked ? 'bg-navy-500' : 'bg-gray-300'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                student.appearance_locked ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Session hard stop — on by default and there by design; the
            parent (already behind the parent password to be on this page)
            may extend it, but never beyond 4 hours, and every hour of
            session time still gets its mandatory 10-minute break. */}
        <div className="p-3 bg-gray-50 rounded-xl">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-gray-700">{t('parentSetup.sessionLength')}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {t('parentSetup.sessionLengthHelp')}
              </p>
            </div>
            <div className="w-24 flex-shrink-0">
              <input
                type="number"
                min={30}
                max={240}
                step={15}
                value={student.session_cap_minutes}
                onChange={(e) =>
                  onUpdate({ session_cap_minutes: Math.max(30, Math.min(240, Number(e.target.value) || 120)) })
                }
                className="input"
              />
              <p className="text-xs text-gray-400 mt-1 text-center">{t('parentSetup.minutes')}</p>
            </div>
          </div>
        </div>

        {/* Screen time limit + eye-rest break */}
        <div className="p-3 bg-gray-50 rounded-xl space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-700">{t('parentSetup.limitScreenTime')}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {student.screen_time_limit_enabled
                  ? t('parentSetup.screenTimeOn', { minutes: student.screen_time_limit_minutes })
                  : t('parentSetup.screenTimeOff')}
              </p>
            </div>
            <button
              onClick={() => onUpdate({ screen_time_limit_enabled: !student.screen_time_limit_enabled })}
              className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
                student.screen_time_limit_enabled ? 'bg-navy-500' : 'bg-gray-300'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  student.screen_time_limit_enabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {student.screen_time_limit_enabled && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">{t('parentSetup.screenTimeCapLabel')}</label>
                <input
                  type="number"
                  min={15}
                  max={480}
                  step={5}
                  value={student.screen_time_limit_minutes}
                  onChange={(e) =>
                    onUpdate({ screen_time_limit_minutes: Math.max(15, Math.min(480, Number(e.target.value) || 15)) })
                  }
                  className="input"
                />
              </div>
              <div>
                <label className="label">{t('parentSetup.eyeRestBreakLabel')}</label>
                <input
                  type="number"
                  min={30}
                  max={120}
                  step={5}
                  value={student.eye_rest_break_minutes}
                  onChange={(e) =>
                    onUpdate({ eye_rest_break_minutes: Math.max(30, Math.min(120, Number(e.target.value) || 30)) })
                  }
                  className="input"
                />
                <p className="text-xs text-gray-400 mt-1">{t('parentSetup.eyeRestMinimum')}</p>
              </div>
            </div>
          )}
        </div>

        {/* Voice enrollment */}
        {student.student_name.trim() && student.voice_required && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              {isEnrolled
                ? <><CheckCircle size={13} className="inline text-navy-500 mr-1" />{t('parentSetup.voiceEnrolled')}</>
                : t('parentSetup.noVoiceProfile')}
            </p>
            <button
              onClick={() => onUpdate({ showEnrollment: true })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border-2 border-navy-300 text-navy-700 hover:bg-navy-50 text-xs font-medium transition-colors"
            >
              <Mic size={12} />
              {isEnrolled ? t('parentSetup.reEnrol') : t('parentSetup.enrolVoice')}
            </button>
          </div>
        )}

        {/* Term & mastery outcomes */}
        <div className="p-3 bg-gray-50 rounded-xl space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-gray-700">{t('parentSetup.termMasteryOutcomes')}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {student.term_schedule === 'trimester'
                  ? t('parentSetup.trimesterYear')
                  : t('parentSetup.quarterYear')} · {t('parentSetup.termMasterySuffix')}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <select
                value={student.term_schedule}
                onChange={(e) => {
                  const term_schedule = e.target.value as TermSchedule
                  onUpdate({
                    term_schedule,
                    current_term: Math.min(student.current_term, term_schedule === 'trimester' ? 3 : 4),
                  })
                }}
                className="input !w-auto text-xs py-1.5"
              >
                <option value="trimester">{t('parentSetup.termsOption')}</option>
                <option value="quarterly">{t('parentSetup.quartersOption')}</option>
              </select>
              <select
                value={student.current_term}
                onChange={(e) => onUpdate({ current_term: Number(e.target.value) })}
                className="input !w-auto text-xs py-1.5"
              >
                {Array.from({ length: student.term_schedule === 'trimester' ? 3 : 4 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {student.term_schedule === 'trimester' ? t('parentSetup.termN', { n }) : t('parentSetup.quarterN', { n })}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            {CORE_AREAS.map(({ id, label }) => (
              <div key={id}>
                <label className="label text-xs">{label}</label>
                <input
                  type="text"
                  value={student.term_topics[id]}
                  onChange={(e) => onUpdate({ term_topics: { ...student.term_topics, [id]: e.target.value } })}
                  placeholder={t('parentSetup.termTopicsPlaceholder')}
                  className="input text-xs"
                />
              </div>
            ))}
            <p className="text-xs text-gray-400">
              {t('parentSetup.termTopicsHelp')}
            </p>
          </div>
        </div>

        {/* Pick up where we left off — the parent tells Bede where an
            interrupted lesson stopped, so the subject resumes mid-thread
            instead of opening as though it were new. A note can only ever
            attach to a subject chosen above; there's no free-text topic
            field, by design. */}
        <div className="p-3 bg-gray-50 rounded-xl space-y-3">
          <div>
            <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
              <BookMarked size={14} className="text-navy-500" /> {t('parentSetup.resumeTitle')}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">{t('parentSetup.resumeHelp')}</p>
          </div>

          {student.lesson_resume.map((entry, ri) => {
            const takenElsewhere = student.lesson_resume
              .filter((_, k) => k !== ri)
              .map((r) => r.subject)
            // The row's own subject stays in the list even if it was later
            // deselected above, so the parent can see what it points at
            // rather than the select silently blanking.
            const options = [
              ...student.selected_subjects.filter((s) => !takenElsewhere.includes(s)),
              ...(entry.subject && !student.selected_subjects.includes(entry.subject)
                ? [entry.subject]
                : []),
            ]
            const notScheduled = !!entry.subject && !student.selected_subjects.includes(entry.subject)
            return (
              <div key={ri} className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <select
                    value={entry.subject}
                    onChange={(e) => updateResume(ri, { subject: e.target.value as Subject | '' })}
                    className="input !w-auto flex-1 text-xs py-1.5"
                  >
                    <option value="">{t('parentSetup.resumeChooseSubject')}</option>
                    {options.map((s) => (
                      <option key={s} value={s}>{SUBJECT_MAP[s].label}</option>
                    ))}
                  </select>
                  <input
                    type="date"
                    value={entry.recorded_on}
                    onChange={(e) => updateResume(ri, { recorded_on: e.target.value })}
                    title={t('parentSetup.resumeDate')}
                    className="input !w-auto text-xs py-1.5"
                  />
                  <button
                    onClick={() => removeResume(ri)}
                    title={t('parentSetup.resumeRemove')}
                    className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors flex-shrink-0"
                  >
                    <X size={14} />
                  </button>
                </div>

                {notScheduled && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                    {t('parentSetup.resumeSubjectNotScheduled')}
                  </p>
                )}

                <div>
                  <label className="label text-xs">{t('parentSetup.resumeStoppedAt')}</label>
                  <textarea
                    value={entry.stopped_at}
                    onChange={(e) => updateResume(ri, { stopped_at: e.target.value })}
                    placeholder={t('parentSetup.resumeStoppedAtPlaceholder')}
                    rows={2}
                    maxLength={300}
                    className="input text-xs resize-none"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="label text-xs">{t('parentSetup.resumeNextStep')}</label>
                    <input
                      type="text"
                      value={entry.next_step}
                      onChange={(e) => updateResume(ri, { next_step: e.target.value })}
                      placeholder={t('parentSetup.resumeNextStepPlaceholder')}
                      maxLength={300}
                      className="input text-xs"
                    />
                  </div>
                  <div>
                    <label className="label text-xs">{t('parentSetup.resumeStickingPoint')}</label>
                    <input
                      type="text"
                      value={entry.sticking_point}
                      onChange={(e) => updateResume(ri, { sticking_point: e.target.value })}
                      placeholder={t('parentSetup.resumeStickingPointPlaceholder')}
                      maxLength={300}
                      className="input text-xs"
                    />
                  </div>
                </div>
              </div>
            )
          })}

          {student.lesson_resume.length < student.selected_subjects.length && (
            <button
              onClick={addResume}
              className="flex items-center gap-1.5 text-xs font-medium text-navy-600 hover:text-navy-800"
            >
              <Plus size={13} /> {t('parentSetup.resumeAdd')}
            </button>
          )}
          <p className="text-xs text-gray-400">{t('parentSetup.resumeOnlyChosenSubjects')}</p>
        </div>

        {/* Optional context — collapsed by default */}
        <div>
          <button
            onClick={() => onUpdate({ expandedContext: !student.expandedContext })}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700"
          >
            {student.expandedContext ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {t('parentSetup.sessionContextOptional')}
          </button>
          {student.expandedContext && (
            <div className="mt-3 space-y-3">
              <div>
                <label className="label">{t('parentSetup.currentUnit')}</label>
                <input
                  type="text"
                  value={student.current_unit}
                  onChange={(e) => onUpdate({ current_unit: e.target.value })}
                  placeholder={t('parentSetup.currentUnitPlaceholder')}
                  className="input"
                />
              </div>
              <div>
                <label className="label">{t('parentSetup.faithFocus')}</label>
                <input
                  type="text"
                  value={student.faith_emphasis}
                  onChange={(e) => onUpdate({ faith_emphasis: e.target.value })}
                  placeholder={t('parentSetup.faithFocusPlaceholder')}
                  className="input"
                />
              </div>
              <div>
                <label className="label">{t('parentSetup.noteForBede')}</label>
                <textarea
                  value={student.lesson_focus}
                  onChange={(e) => onUpdate({ lesson_focus: e.target.value })}
                  placeholder={t('parentSetup.noteForBedePlaceholder')}
                  rows={2}
                  className="input resize-none"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {student.showEnrollment && student.student_name.trim() && (
        <VoiceEnrollment
          studentName={student.student_name.trim()}
          onEnrolled={onEnrolled}
          onClose={() => onUpdate({ showEnrollment: false })}
        />
      )}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-navy-100 shadow-sm p-5">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">{title}</h2>
      {children}
    </div>
  )
}
