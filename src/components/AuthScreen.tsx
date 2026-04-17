import { useState, type FormEvent } from 'react';

interface AuthScreenProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (payload: { email: string; password: string; displayName: string }) => Promise<void>;
}

export function AuthScreen({ onLogin, onRegister }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      if (mode === 'login') {
        await onLogin(email, password);
      } else {
        await onRegister({ email, password, displayName });
        setSuccess('Account created. An admin now needs to approve it before you can access the patrol dashboard.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <div className="auth-panel__glow" />
        <div className="auth-panel__content">
          <span className="eyebrow">Patrol Hub</span>
          <h1>LNW Patrol Map.</h1>
          <p>
            Live patrol map, active patrollers list, assistance alerts, route planning, and a message board.
          </p>

          <div className="auth-toggle">
            <button
              type="button"
              className={mode === 'login' ? 'active' : ''}
              onClick={() => {
                setMode('login');
                setError(null);
                setSuccess(null);
              }}
            >
              Log in
            </button>
            <button
              type="button"
              className={mode === 'register' ? 'active' : ''}
              onClick={() => {
                setMode('register');
                setError(null);
                setSuccess(null);
              }}
            >
              Create account
            </button>
          </div>

          <form className="auth-form" onSubmit={handleSubmit}>
            {mode === 'register' ? (
              <label>
                Full name
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Jane Doe"
                  minLength={3}
                  maxLength={40}
                  title="Use 3 to 40 characters. Letters, numbers, spaces, apostrophes, dots, and hyphens are allowed."
                  required
                />
              </label>
            ) : null}

            <label>
              Email
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                placeholder="you@example.com"
                required
              />
            </label>

            <label>
              Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type={showPassword ? 'text' : 'password'}
                placeholder="At least 6 characters"
                minLength={6}
                required
              />
            </label>

            <label className="password-toggle">
              <input
                type="checkbox"
                checked={showPassword}
                onChange={(event) => setShowPassword(event.target.checked)}
              />
              <span>Show password</span>
            </label>

            {error ? <div className="form-message form-message--error">{error}</div> : null}
            {success ? <div className="form-message form-message--success">{success}</div> : null}

            <button className="primary-button" type="submit" disabled={loading}>
              {loading ? 'Working...' : mode === 'login' ? 'Log in' : 'Create pending account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
