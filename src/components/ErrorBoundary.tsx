import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({
      error,
      errorInfo,
    });
    // You can also log the error to an error reporting service here
    console.error("Uncaught error captured by ErrorBoundary:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 font-sans">
          <div className="max-w-xl w-full bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
            <div className="bg-red-50 border-b border-red-100 p-6 flex items-center gap-4">
              <div className="bg-red-500 text-white p-3 rounded-full">
                <AlertTriangle className="w-8 h-8" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-slate-800">Something went wrong</h1>
                <p className="text-sm text-slate-500 mt-1">
                  We ran into an unexpected error and the application crashed.
                </p>
              </div>
            </div>

            <div className="p-6 space-y-4">
              {this.state.error && (
                <div className="space-y-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 block">
                    Error Message
                  </span>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm font-mono text-slate-700 whitespace-pre-wrap">
                    {this.state.error.toString()}
                  </div>
                </div>
              )}

              {this.state.errorInfo && (
                <div className="space-y-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 block">
                    Stack Trace
                  </span>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs font-mono text-slate-500 max-h-48 overflow-y-auto whitespace-pre-wrap">
                    {this.state.errorInfo.componentStack}
                  </div>
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-3 pt-2">
                <button
                  onClick={() => window.location.reload()}
                  className="flex items-center justify-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl transition-colors shadow-sm text-sm"
                >
                  <RefreshCw className="w-4 h-4 animate-spin-hover" />
                  Reload App
                </button>
                <button
                  onClick={() => { window.location.href = '/'; }}
                  className="flex items-center justify-center gap-2 px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium rounded-xl transition-colors text-sm"
                >
                  <Home className="w-4 h-4" />
                  Go to Homepage
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
