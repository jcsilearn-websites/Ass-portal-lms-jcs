import { zodResolver } from '@hookform/resolvers/zod'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router-dom'
import { z } from 'zod'
import { ApiError } from '@/api'
import { getRoleHomePath } from '@/routes/roles'
import { useLogin } from '../api'
import styles from './LoginPage.module.css'

const MirrorCubeScene = lazy(() => import('../components/MirrorCubeScene'))

// Static fallback: on slow connections, low-end devices, or when the user
// prefers reduced motion, skip the WebGL scene entirely and let the CSS
// gradient (already rendered underneath) stand alone as the background.
function useCanRender3D() {
  const [canRender, setCanRender] = useState(false)

  useEffect(() => {
    const nav = navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string }
    }
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const saveData = nav.connection?.saveData
    const slowConnection = ['slow-2g', '2g'].includes(nav.connection?.effectiveType ?? '')
    const lowEndDevice = (navigator.hardwareConcurrency ?? 8) <= 2

    if (reducedMotion || saveData || slowConnection || lowEndDevice) return

    try {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      setCanRender(Boolean(gl))
    } catch {
      setCanRender(false)
    }
  }, [])

  return canRender
}

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

type LoginFormValues = z.infer<typeof loginSchema>

// Segment-hop path the football travels along, expressed as fractions of the
// left panel's own size — ported 1:1 from jcs-ilearn-login-football.html so
// it still lands on the dotless-ı target regardless of viewport size.
function buildSegments(panelWidth: number, panelHeight: number, endX: number, endY: number) {
  const startX = panelWidth * 0.9
  const startY = panelHeight * 0.92
  return [
    { x0: startX, y0: startY, x1: panelWidth * 0.74, y1: panelHeight * 0.66, peak: 70, size: 26, dur: 520 },
    {
      x0: panelWidth * 0.74,
      y0: panelHeight * 0.66,
      x1: panelWidth * 0.55,
      y1: panelHeight * 0.46,
      peak: 80,
      size: 22,
      dur: 480,
    },
    {
      x0: panelWidth * 0.55,
      y0: panelHeight * 0.46,
      x1: panelWidth * 0.34,
      y1: panelHeight * 0.3,
      peak: 65,
      size: 18,
      dur: 440,
    },
    { x0: panelWidth * 0.34, y0: panelHeight * 0.3, x1: endX, y1: endY, peak: 50, size: 9, dur: 420 },
  ]
}

function easeOutQuad(t: number) {
  return 1 - (1 - t) * (1 - t)
}

// Animates the football hopping from the bottom-right of the brand panel up
// to the dotless-ı in "ıLearn", then settles into a spin — becoming the dot
// on the i. Ported from the source HTML's vanilla-JS IIFE; kept as one
// imperative rAF loop (not React state per frame) since it drives raw
// style.left/top/width on a ref, matching the original's DOM approach and
// avoiding a re-render on every animation frame.
function useFootballAnimation(
  leftRef: React.RefObject<HTMLDivElement | null>,
  ballRef: React.RefObject<HTMLDivElement | null>,
  targetRef: React.RefObject<HTMLSpanElement | null>,
) {
  useEffect(() => {
    let cancelled = false
    let rafId = 0
    let settleTimeoutId = 0
    let startTimeoutId = 0

    function run() {
      const left = leftRef.current
      const ball = ballRef.current
      const target = targetRef.current
      if (cancelled || !left || !ball || !target) return

      const panelRect = left.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()

      const endX = targetRect.left + targetRect.width / 2 - panelRect.left
      const endY = targetRect.top - panelRect.top - 6

      const segments = buildSegments(panelRect.width, panelRect.height, endX, endY)

      ball.style.opacity = '1'
      let segIndex = 0
      let segStart = performance.now()

      function frame(now: number) {
        if (cancelled || !ball) return
        const seg = segments[segIndex]!
        let t = (now - segStart) / seg.dur
        if (t > 1) t = 1

        const x = seg.x0 + (seg.x1 - seg.x0) * easeOutQuad(t)
        const straightY = seg.y0 + (seg.y1 - seg.y0) * t
        const y = straightY - seg.peak * 4 * t * (1 - t)
        const prevSize = segIndex === 0 ? 26 : segments[segIndex - 1]!.size
        const size = prevSize + (seg.size - prevSize) * t

        ball.style.left = `${x - size / 2}px`
        ball.style.top = `${y - size / 2}px`
        ball.style.width = `${size}px`
        ball.style.height = `${size}px`

        if (t < 1) {
          rafId = requestAnimationFrame(frame)
        } else if (segIndex < segments.length - 1) {
          segIndex++
          segStart = now
          rafId = requestAnimationFrame(frame)
        } else {
          settle()
        }
      }

      function settle() {
        if (cancelled || !ball) return
        const wobbles = [
          { dy: -6, dur: 120 },
          { dy: 0, dur: 110 },
          { dy: -3, dur: 100 },
          { dy: 0, dur: 90 },
        ]
        let i = 0
        const baseTop = Number.parseFloat(ball.style.top)

        function nextWobble() {
          if (cancelled || !ball) return
          if (i >= wobbles.length) {
            ball.classList.add(styles.spin!)
            return
          }
          const w = wobbles[i]!
          ball.style.transition = `top ${w.dur}ms ease-out`
          ball.style.top = `${baseTop + w.dy}px`
          i++
          settleTimeoutId = window.setTimeout(nextWobble, w.dur)
        }
        nextWobble()
      }

      rafId = requestAnimationFrame(frame)
    }

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (!cancelled) startTimeoutId = window.setTimeout(run, 400)
      })
    } else {
      startTimeoutId = window.setTimeout(run, 700)
    }

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      window.clearTimeout(settleTimeoutId)
      window.clearTimeout(startTimeoutId)
    }
  }, [leftRef, ballRef, targetRef])
}

export default function LoginPage() {
  const navigate = useNavigate()
  const login = useLogin()
  const [showPassword, setShowPassword] = useState(false)
  const canRender3D = useCanRender3D()

  const leftRef = useRef<HTMLDivElement>(null)
  const ballRef = useRef<HTMLDivElement>(null)
  const dotTargetRef = useRef<HTMLSpanElement>(null)
  useFootballAnimation(leftRef, ballRef, dotTargetRef)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  })

  const onSubmit = handleSubmit((values) => {
    login.mutate(values, {
      onSuccess: (data) => navigate(getRoleHomePath(data.user.roles), { replace: true }),
    })
  })

  return (
    <div className={styles.wrap}>
      <div className={styles.bgLayer} aria-hidden="true">
        <div className={styles.bgGradient} />
        {canRender3D && (
          <Suspense fallback={null}>
            <div className={styles.bgCanvas}>
              <MirrorCubeScene />
            </div>
          </Suspense>
        )}
      </div>

      <div className={styles.left} ref={leftRef}>
        <div className={styles.football} ref={ballRef} />
        <div>
          <div className={styles.brandRow}>
            <div className={styles.mark}>
              <img src="/jcs-logo.png" alt="JCS iLearn logo" />
            </div>
            <div>
              <div className={styles.brandName}>
                JCS <span ref={dotTargetRef} className={styles.dotTarget}>ı</span>Learn
              </div>
              <div className={styles.brandTag}>Assessment platform</div>
            </div>
          </div>

          <div className={styles.hero}>
            <div className={styles.hiLine}>
              H<span className={styles.iBlink}>I</span>
            </div>
          </div>
        </div>

        <div className={styles.bottomBlock}>
          <p className={styles.heroDesc}>
            MCQ, coding, and psychometric tests under live proctoring — with
            placement-readiness analytics the moment a test wraps up.
          </p>
        </div>
      </div>

      <div className={styles.right}>
        <div className={styles.formCol}>
          <div className={styles.formHead}>
            <div className={styles.eyebrowLight}>Welcome back</div>
            <h2>Sign in to your account</h2>
            <p>Enter your credentials to access your dashboard.</p>
          </div>

          <form onSubmit={onSubmit} noValidate>
            <div className={styles.field}>
              <label htmlFor="email">Email</label>
              <div className={styles.inputLine}>
                <input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  autoComplete="email"
                  {...register('email')}
                />
              </div>
              {errors.email && <p className={styles.fieldError}>{errors.email.message}</p>}
            </div>

            <div className={styles.field}>
              <label htmlFor="password">Password</label>
              <div className={styles.inputLine}>
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  {...register('password')}
                />
                <button
                  type="button"
                  className={styles.icon}
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? 'hide' : 'show'}
                </button>
              </div>
              {errors.password && <p className={styles.fieldError}>{errors.password.message}</p>}
            </div>

            <div className={styles.rowBetween}>
              <label className={styles.remember}>
                <input type="checkbox" /> Remember me
              </label>
              <a className={styles.forgot} href="#">
                Forgot password?
              </a>
            </div>

            {login.isError && (
              <p className={styles.formError}>
                {login.error instanceof ApiError ? login.error.message : 'Login failed. Please try again.'}
              </p>
            )}

            <button className={styles.btnSignin} type="submit" disabled={login.isPending}>
              {login.isPending ? 'Signing in…' : 'Sign in'}
              <span className={styles.arrow}>→</span>
            </button>

            <div className={styles.dividerNote}>Access is restricted to unregistered institutions</div>
          </form>

          <div className={styles.foot}>
            <span>Powered by JCS iLearn</span>
          </div>
        </div>
      </div>
    </div>
  )
}
