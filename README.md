# genScript: Google Labs ImageFX Automation

An automation script designed to run in the browser console of Google Labs (ImageFX / Flow UI) to programmatically generate images in bulk using a rotation of different environments and poses, while maintaining a consistent character reference image.

## Features

- **Character Reference Lock**: Automatically adds and locks a consistent character reference image from the Google Labs asset browser before prompt insertion.
- **Dynamic Prompt Construction**: Rotates through configurations of environments and poses, compiling them into a structured JSON prompt template.
- **Slate.js Integration**: Uses multi-layered event delegation (including synthetic paste and beforeinput events) to sync changes directly into the Slate.js editor state, ensuring the page registers the input.
- **Robust Clicking Mechanisms**: Automatically targets the generate button by matching text content, ARIA attributes, and icon classes. Simulates coordinate-based mouse and pointer events and bubbles click callbacks up the React Fiber node tree to bypass anti-automation/trusted event restrictions.

## Usage

1. Open **Google Labs (Flow UI / ImageFX)** in your browser and sign in.
2. Open the browser's Developer Tools Console (`F12` or `Cmd+Option+I` on Mac).
3. Paste the contents of `script.js` into the console and press **Enter**.
4. The script will automatically begin iterating through environments and poses, inserting them, setting the character reference, and triggering generation.

## File Structure

- [script.js](file:///Users/alexpoole/Documents/genScript/script.js): The main JavaScript automation script.
