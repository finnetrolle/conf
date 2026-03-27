import {
  ArrowRight,
  Link2,
  Share2,
  ShieldCheck,
  Sparkles,
  TimerReset,
  Video,
} from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { createSession, humanizeError } from "@/lib/api"

const steps = [
  {
    icon: Link2,
    title: "Создать сессию",
    text: "Один клик открывает персональную ссылку и сразу переводит в экран звонка.",
  },
  {
    icon: Video,
    title: "Проверить устройства",
    text: "Камера, микрофон и локальное превью доступны сразу, без отдельного мастера настройки.",
  },
  {
    icon: Share2,
    title: "Отправить приглашение",
    text: "Мессенджеры, SMS, системный share и QR-код помогают подключить второго участника в один шаг.",
  },
]

const highlights = [
  {
    value: "1 приглашение",
    label: "достаточно, чтобы второй участник открыл тот же звонок без лишних объяснений",
  },
  {
    value: "1 экран",
    label: "создание, превью устройств и сам созвон живут в одном месте",
  },
  {
    value: "0 аккаунтов",
    label: "не нужно регистрироваться, собирать контакты или подтверждать вход",
  },
]

const benefits = [
  {
    icon: Sparkles,
    title: "Чистый старт",
    text: "Первый экран сразу объясняет сценарий и не спорит с главным действием.",
  },
  {
    icon: ShieldCheck,
    title: "Меньше трения",
    text: "Никаких промежуточных комнат, приглашений по почте и лишних подтверждений.",
  },
  {
    icon: TimerReset,
    title: "Сессия не зависает",
    text: "Когда оба участника выходят, сервер автоматически завершает встречу.",
  },
]

export function LandingPage() {
  const navigate = useNavigate()
  const [isCreating, setIsCreating] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleCreateSession() {
    setIsCreating(true)
    setErrorMessage(null)

    try {
      const response = await createSession()
      const targetUrl = new URL(response.hostUrl, window.location.origin)
      if (targetUrl.origin !== window.location.origin) {
        window.location.assign(response.hostUrl)
        return
      }

      navigate(targetUrl.pathname + targetUrl.search)
    } catch (error) {
      setErrorMessage(humanizeError(error))
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <main className="relative overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-[38rem] bg-[radial-gradient(circle_at_top_left,rgba(255,166,94,0.22),transparent_38%),radial-gradient(circle_at_top_right,rgba(34,211,238,0.18),transparent_32%)]" />
      <div className="absolute left-1/2 top-24 h-72 w-72 -translate-x-1/2 rounded-full bg-orange-200/25 blur-3xl" />

      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col gap-8 px-6 py-8 sm:py-10">
        <section className="relative overflow-hidden rounded-[40px] border border-white/70 bg-white/72 px-6 py-8 shadow-[0_32px_90px_-48px_rgba(15,23,42,0.45)] backdrop-blur-2xl sm:px-8 sm:py-10 lg:px-10">
          <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.82),rgba(255,248,240,0.5)_42%,rgba(239,246,255,0.55))]" />
          <div className="relative grid gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(340px,0.95fr)] lg:items-center">
            <div className="space-y-8">
              <div className="inline-flex items-center rounded-full border border-orange-200 bg-orange-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-orange-700 shadow-sm">
                Browser-first 1:1 calling
              </div>

              <div className="space-y-5">
                <h1 className="max-w-4xl font-display text-5xl font-bold leading-[0.92] text-slate-950 md:text-7xl">
                  Один быстрый звонок.
                  <br />
                  Одно приглашение.
                  <br />
                  Ни одного лишнего шага.
                </h1>
                <p className="max-w-2xl text-lg leading-8 text-slate-600 sm:text-[1.15rem]">
                  Открываешь страницу, создаешь сессию и сразу попадаешь в звонок. Второй участник получает понятное
                  приглашение, открывает ссылку или QR и попадает в тот же интерфейс без регистрации и промежуточных экранов.
                </p>
              </div>

              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <Button
                  className="h-14 gap-2 px-7 text-base shadow-[0_18px_40px_-22px_rgba(249,115,22,0.85)]"
                  size="lg"
                  onClick={handleCreateSession}
                  disabled={isCreating}
                >
                  {isCreating ? "Создаем сессию..." : "Создать сессию"}
                  <ArrowRight className="h-4 w-4" />
                </Button>
                <p className="max-w-xs text-sm leading-6 text-slate-500">
                  После создания ты сразу попадешь в звонок и сможешь отправить приглашение второму участнику удобным способом.
                </p>
              </div>

              {errorMessage ? (
                <p className="max-w-xl rounded-[24px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
                  {errorMessage}
                </p>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-3">
                {highlights.map((item) => (
                  <div
                    key={item.value}
                    className="rounded-[26px] border border-white/80 bg-white/80 p-4 shadow-[0_20px_45px_-35px_rgba(15,23,42,0.45)]"
                  >
                    <p className="text-lg font-bold text-slate-950">{item.value}</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{item.label}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="relative pt-12 sm:pt-16 lg:pt-10">
              <div className="absolute right-0 top-0 z-10 hidden w-56 rounded-[28px] border border-orange-200/80 bg-orange-100 p-4 text-slate-950 shadow-[0_24px_60px_-36px_rgba(15,23,42,0.5)] sm:block">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">Что видно сразу</p>
                <p className="mt-2 text-base font-semibold leading-6">Камеру, микрофон и статус подключения с первого взгляда.</p>
              </div>

              <div className="relative overflow-hidden rounded-[34px] border border-slate-900/10 bg-slate-950 p-5 text-white shadow-[0_36px_90px_-42px_rgba(15,23,42,0.75)] sm:p-6">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(125,211,252,0.25),transparent_30%),radial-gradient(circle_at_bottom_left,rgba(251,146,60,0.3),transparent_36%)]" />
                <div className="relative space-y-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="max-w-sm">
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-300">Экран встречи</p>
                      <h2 className="mt-3 font-display text-3xl leading-tight text-white">Все важное собрано в одном понятном блоке.</h2>
                    </div>
                    <div className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200">
                      live flow
                    </div>
                  </div>

                  <div className="grid gap-3">
                    {steps.map((item, index) => (
                      <div
                        key={item.title}
                        className="rounded-[26px] border border-white/10 bg-white/8 p-4 backdrop-blur-xl"
                      >
                        <div className="flex items-start gap-4">
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/12 text-orange-300">
                            <item.icon className="h-5 w-5" />
                          </div>
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
                              Шаг {index + 1}
                            </p>
                            <p className="mt-1 text-lg font-semibold text-white">{item.title}</p>
                            <p className="mt-2 text-sm leading-6 text-slate-300">{item.text}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-[24px] border border-white/12 bg-white px-4 py-4 text-slate-950">
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Внутри звонка</p>
                      <p className="mt-2 text-sm font-medium leading-6">
                        Приглашение отправляется одной кнопкой прямо из интерфейса видеосвязи.
                      </p>
                    </div>
                    <div className="rounded-[24px] border border-white/12 bg-sky-100 px-4 py-4 text-slate-950">
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">После встречи</p>
                      <p className="mt-2 text-sm font-medium leading-6">
                        Пустые сессии не висят бесконечно: сервер завершает их автоматически.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-[34px] border border-white/70 bg-slate-950 px-6 py-6 text-white shadow-[0_28px_80px_-46px_rgba(15,23,42,0.65)]">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Для быстрых созвонов</p>
            <h3 className="mt-4 max-w-lg font-display text-3xl leading-tight">Когда нужно просто созвониться, интерфейс не должен мешать.</h3>
            <p className="mt-4 max-w-xl text-sm leading-7 text-slate-300">
              Сервис оставляет только ключевые действия: создать сессию, отправить приглашение, проверить устройства и
              завершить встречу без лишних сущностей вокруг.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {benefits.map((item) => (
              <div
                key={item.title}
                className="glass-panel rounded-[30px] border border-white/70 px-5 py-5 shadow-[0_24px_60px_-40px_rgba(15,23,42,0.4)]"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-950 text-orange-300">
                  <item.icon className="h-5 w-5" />
                </div>
                <p className="mt-4 text-lg font-semibold text-slate-950">{item.title}</p>
                <p className="mt-2 text-sm leading-7 text-slate-600">{item.text}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  )
}
