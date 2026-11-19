/** @type {import('tailwindcss').Config} */
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const ramp = (name) =>
  Object.fromEntries(STEPS.map((s) => [s, `rgb(var(--${name}-${s}) / <alpha-value>)`]))

export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    // override, not extend: a removed family must fail visibly, not drift back
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      inherit: 'inherit',
      white: '#ffffff',
      black: '#000000',
      gray: ramp('gray'),
      blue: ramp('blue'),
      green: ramp('green'),
      yellow: ramp('yellow'),
      red: ramp('red'),
    },
    boxShadow: {
      DEFAULT: 'var(--mt-shadow-sm)',
      none: 'none',
      sm: 'var(--mt-shadow-sm)',
      md: 'var(--mt-shadow-md)',
      lg: 'var(--mt-shadow-lg)',
      xl: 'var(--mt-shadow-xl)',
      focus: '0 0 0 2px rgb(var(--gray-50)), 0 0 0 4px rgb(var(--blue-400) / 0.7)',
    },
  },
  plugins: [],
}
