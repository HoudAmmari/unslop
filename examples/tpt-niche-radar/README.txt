NICHE RADAR 4.0 · TPT OPPORTUNITY STUDIO

Open START-HERE.html for the full guide with screenshots.

UPDATE AN EXISTING INSTALL (your research stays)
1. Optional: in your current workspace, click Back up workspace.
2. Extract this zip INTO THE SAME FOLDER you loaded before and replace the files.
   Keep the folder where it is, Chrome ties your stored research to that folder.
3. chrome://extensions > click the reload arrow on Niche Radar.
4. Reload any open TPT tabs.
Version 4 reads the same storage as version 3 and keeps an untouched copy of your
v3 workspace on its first save (download it from Scoring and help).

FIRST INSTALL
chrome://extensions > Developer mode > Load unpacked > choose the folder with manifest.json.

ON TPT
Seller Dashboard > Site Search Analytics > search a keyword. The panel in the corner saves
the monthly average, total searches, peak month and share, the 53-week curve and the related
keywords. "Collect all 100" saves every related page. It never runs a search for you.

FILES
manifest.json, background.js   extension and background worker
core.js                        data engine: parsing, merging, scores, seasons
storage.js, ingest.js          browser storage and saving captures
capture-reader.js              reads TPT keyword tables, including Peak Season
insight-reader.js              reads the single keyword view and its weekly chart
companion.js                   the panel on TPT pages
dashboard.*, popup.*, theme.js the workspace and the toolbar popup
tests/                         node --test tests/   (the browser test needs Playwright)

No build step, no API key, no subscription. Everything stays in this browser.
