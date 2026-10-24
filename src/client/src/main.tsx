import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6 font-mono">
          <div className="max-w-lg w-full bg-slate-900 border border-rose-500/50 rounded-2xl p-6 space-y-3">
            <h1 className="text-base font-bold text-rose-400">SAIL Client Runtime Error</h1>
            <p className="text-xs text-slate-300">
              {this.state.error?.message || 'An unexpected rendering error occurred.'}
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Root container '#root' not found in index.html");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
);
