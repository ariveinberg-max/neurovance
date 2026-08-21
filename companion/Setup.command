#!/bin/bash
# Double-click this file — no Terminal knowledge needed. It opens a terminal
# window itself, installs what it needs, and starts the Companion.
cd "$(dirname "$0")"

# A double-clicked .command file doesn't reliably source the same shell
# startup files as a normal interactive Terminal window, so PATH additions
# living in .zshrc (Homebrew's included) can be silently missing — node/npm
# work fine typed by hand but "aren't found" here. Add the common install
# locations directly instead of trusting PATH already has them.
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.local/bin:$PATH"

echo "Setting up your Neurovance Companion..."
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed on this Mac yet — the Companion needs it to run."
  echo ""
  echo "Get it here (takes about a minute): https://nodejs.org"
  echo "Pick the LTS version, install it, then come back and double-click this file again."
  echo ""
  read -p "Press Enter to close this window..."
  exit 1
fi

echo "Installing (only needed the first time — this can take a minute)..."
npm install --silent
if [ $? -ne 0 ]; then
  echo ""
  echo "Something went wrong during setup. Try double-clicking this file again — if it keeps failing, ask for help."
  read -p "Press Enter to close this window..."
  exit 1
fi

echo ""
echo "Starting the Companion. Go to Neurovance, click \"Pair a computer\" to get a code, then paste it below."
echo ""
npm start
