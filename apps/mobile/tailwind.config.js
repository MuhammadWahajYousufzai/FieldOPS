/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.tsx", "./app/**/*.{js,jsx,ts,tsx}", "./lib/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        ink: "#102A58",
        field: "#5269FF",
        sky: "#1FC7FF",
        gold: "#FFC938",
        paper: "#F5F7FF",
        line: "#DCE4F2",
        muted: "#60708C",
        success: "#168267",
        danger: "#B8473E",
      },
    },
  },
  plugins: [],
};
