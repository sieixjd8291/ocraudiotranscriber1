import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './index.css';

// Suppress benign Vite WebSocket errors from appearing in the preview overlay
const originalConsoleError = console.error;
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

console.error = (...args: any[]) => {
  if (typeof args[0] === 'string' && (args[0].includes('[vite] failed to connect to websocket') || args[0].includes('WebSocket closed without opened'))) {
    return;
  }
  originalConsoleError.apply(console, args);
};

console.log = (...args: any[]) => {
  if (typeof args[0] === 'string' && args[0].includes('[vite] connecting...')) {
    return;
  }
  originalConsoleLog.apply(console, args);
};

console.warn = (...args: any[]) => {
  if (typeof args[0] === 'string' && (args[0].includes('WebSocket') || args[0].includes('Mismatched sample rates'))) {
    return;
  }
  originalConsoleWarn.apply(console, args);
}

window.addEventListener('error', (event) => {
  if (event.message && (event.message.includes('WebSocket') || event.message.includes('vite'))) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
});

window.addEventListener('unhandledrejection', (event) => {
  if (event.reason === "WebSocket closed without opened.") {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  const reason = event.reason;
  if (reason) {
    const msg = typeof reason === 'string' ? reason : (reason.message || reason.toString() || '');
    if (msg.includes('WebSocket') || msg.includes('vite')) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
});

// Smart Portal-Style Floating Tooltip system.
// This calculates pixel-perfect alignments relative to the entire page viewport,
// completely bypassing any overflow:hidden or styling constraints of parent elements.
if (typeof window !== 'undefined') {
  let activeTarget: HTMLElement | null = null;

  const createTooltipElement = (): HTMLElement => {
    let tooltip = document.getElementById('global-smart-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'global-smart-tooltip';
      tooltip.innerHTML = `
        <div class="smart-tooltip-content" id="global-smart-tooltip-content"></div>
        <div class="smart-tooltip-arrow" id="global-smart-tooltip-arrow"></div>
      `;
      document.body.appendChild(tooltip);
    }
    return tooltip;
  };

  const showTooltip = (target: HTMLElement) => {
    const text = target.getAttribute('data-tooltip') || '';
    if (!text.trim()) return;

    activeTarget = target;
    const tooltip = createTooltipElement();
    const content = document.getElementById('global-smart-tooltip-content');
    const arrow = document.getElementById('global-smart-tooltip-arrow');
    
    if (!content || !arrow) return;

    // Set text
    content.textContent = text;
    
    // Position/display initialization (measure size correctly)
    tooltip.classList.add('show');
    tooltip.style.opacity = '1';
    tooltip.style.transform = 'scale(1) translateY(0)';
    tooltip.style.left = '-9999px';
    tooltip.style.top = '-9999px';

    const rect = target.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const wWidth = tooltipRect.width;
    const wHeight = tooltipRect.height;

    // Choose direct side. Default is "top".
    let side = 'top';
    
    // Explicit hints on classes
    if (target.classList.contains('tooltip-bottom')) {
      side = 'bottom';
    } else if (target.classList.contains('tooltip-left')) {
      side = 'left';
    } else if (target.classList.contains('tooltip-right')) {
      side = 'right';
    }

    // Smart auto-flipping based on viewport borders
    if (side === 'top' && rect.top - wHeight - 12 < 8) {
      side = 'bottom';
    } else if (side === 'bottom' && rect.bottom + wHeight + 12 > viewportHeight - 8) {
      side = 'top';
    }

    let left = 0;
    let top = 0;

    // Reset arrow style custom positions
    arrow.className = 'smart-tooltip-arrow';
    arrow.style.cssText = '';

    if (side === 'top' || side === 'bottom') {
      left = rect.left + rect.width / 2 - wWidth / 2;
      
      // Clamp horizontally to viewport
      const minLeft = 8;
      const maxLeft = viewportWidth - wWidth - 8;
      const clampedLeft = Math.max(minLeft, Math.min(left, maxLeft));
      left = clampedLeft;

      if (side === 'top') {
        top = rect.top - wHeight - 8;
        arrow.classList.add('smart-tooltip-arrow-top');
        arrow.style.bottom = '-4px';
        arrow.style.transform = 'rotate(45deg)';
        const targetCenterRelativeToTooltip = rect.left + rect.width / 2 - left;
        arrow.style.left = `${Math.max(4, Math.min(targetCenterRelativeToTooltip - 4, wWidth - 12))}px`;
      } else {
        top = rect.bottom + 8;
        arrow.classList.add('smart-tooltip-arrow-bottom');
        arrow.style.top = '-4px';
        arrow.style.transform = 'rotate(45deg)';
        const targetCenterRelativeToTooltip = rect.left + rect.width / 2 - left;
        arrow.style.left = `${Math.max(4, Math.min(targetCenterRelativeToTooltip - 4, wWidth - 12))}px`;
      }
    } else {
      // Left / Right alignments
      if (side === 'left') {
        left = rect.left - wWidth - 8;
        // Clamp left element inside screen if needed
        if (left < 8) {
          left = rect.right + 8;
          side = 'right';
        }
      } else {
        left = rect.right + 8;
        if (left + wWidth > viewportWidth - 8) {
          left = rect.left - wWidth - 8;
          side = 'left';
        }
      }

      top = rect.top + rect.height / 2 - wHeight / 2;
      const minTop = 8;
      const maxTop = viewportHeight - wHeight - 8;
      top = Math.max(minTop, Math.min(top, maxTop));

      if (side === 'left') {
        arrow.style.top = `${Math.max(4, Math.min(rect.top + rect.height / 2 - top, wHeight - 12))}px`;
        arrow.style.right = '-4px';
        arrow.style.transform = 'rotate(45deg)';
        arrow.style.borderTopColor = 'transparent';
        arrow.style.borderLeftColor = 'transparent';
      } else {
        arrow.style.top = `${Math.max(4, Math.min(rect.top + rect.height / 2 - top, wHeight - 12))}px`;
        arrow.style.left = '-4px';
        arrow.style.transform = 'rotate(45deg)';
        arrow.style.borderBottomColor = 'transparent';
        arrow.style.borderRightColor = 'transparent';
      }
    }

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.style.opacity = '1';
    tooltip.style.transform = 'scale(1) translateY(0)';
  };

  const hideTooltip = () => {
    const tooltip = document.getElementById('global-smart-tooltip');
    if (tooltip) {
      tooltip.classList.remove('show');
      tooltip.style.opacity = '0';
      tooltip.style.transform = 'scale(0.94) translateY(3px)';
    }
    activeTarget = null;
  };

  // Hardware-level pointer targeting.
  // `mouse` and `pen` are physical pointers → tooltip is shown instantly.
  // `touch` is ignored so taps never produce sticky tooltips on mobile/tablets.
  const handlePointerEnter = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    const target = (event.target as HTMLElement | null)?.closest?.('[data-tooltip]') as HTMLElement | null;
    if (!target) return;
    // Skip redundant re-positioning while the cursor stays on the active target.
    if (activeTarget === target) {
      const tooltip = document.getElementById('global-smart-tooltip');
      if (tooltip && tooltip.classList.contains('show')) return;
    }
    showTooltip(target);
  };

  const handlePointerLeave = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    const related = (event as PointerEvent).relatedTarget as Node | null;
    // Persist the tooltip while the pointer remains anywhere within the
    // active target (including its child elements).
    if (related && activeTarget && activeTarget.contains(related)) return;
    hideTooltip();
  };

  // Keyboard focus also reveals tooltips, but only on cursor-capable devices
  // (mirrors the CSS `@media (hover: hover) and (pointer: fine)` gate) so that
  // mobile taps which happen to focus an element don't trigger a tooltip.
  const finePointerQuery = window.matchMedia
    ? window.matchMedia('(hover: hover) and (pointer: fine)')
    : null;
  const isFinePointerDevice = () => !!(finePointerQuery && finePointerQuery.matches);

  const handleFocusIn = (event: FocusEvent) => {
    if (!isFinePointerDevice()) return;
    const target = (event.target as HTMLElement | null)?.closest?.('[data-tooltip]') as HTMLElement | null;
    if (target) showTooltip(target);
  };

  const handleFocusOut = () => {
    if (!isFinePointerDevice()) return;
    hideTooltip();
  };

  // Eager, capture-phase delegation on `document` targets every `[data-tooltip]`
  // element with a single listener pair, so the very first hover registers with
  // zero lag — no per-element listener bootstrapping required.
  if ('PointerEvent' in window) {
    document.addEventListener('pointerenter', handlePointerEnter, true);
    document.addEventListener('pointerleave', handlePointerLeave, true);
  } else {
    // Legacy fallback for browsers without PointerEvent support.
    document.addEventListener('mouseenter', handlePointerEnter as EventListener, true);
    document.addEventListener('mouseleave', handlePointerLeave as EventListener, true);
  }

  document.addEventListener('focusin', handleFocusIn, true);
  document.addEventListener('focusout', handleFocusOut, true);

  // Dismiss any visible tooltip the instant a touch occurs (mobile safety net).
  document.addEventListener('touchstart', hideTooltip, { capture: true, passive: true });
  document.addEventListener('touchend', hideTooltip, { capture: true, passive: true });

  // Instantly clean up on scroll or resize to prevent tooltips from floating adrift
  window.addEventListener('scroll', hideTooltip, true);
  window.addEventListener('resize', hideTooltip);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Register Service Worker for offline-first support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        console.log('[App] ServiceWorker registered with scope: ', registration.scope);
      })
      .catch((error) => {
        console.warn('[App] ServiceWorker registration failed: ', error);
      });
  });
}

