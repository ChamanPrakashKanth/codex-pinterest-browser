# Signed-in browser verification

Run this procedure with a Pinterest profile you are authorized to use and an existing board intended for testing. Use an original or otherwise authorized image and confirm you have permission from Pinterest for the live automation. [Pinterest Terms of Service](https://policy.pinterest.com/en/terms-of-service) Test each browser in its own run with the correct extension ID. Use a different image for each publication test to avoid deduplication.

1. Follow the README setup and pair the extension. Use English on the desktop website.
2. Use one clearly identifiable JPEG or PNG. Ask Codex to inspect the image and write a title, description and alt text. Choose a board from real candidates. Review the generated fields for visible evidence, natural search terms, exact board spelling, and faithful alt text.
3. Run the dry-run command. Confirm validation passes, no composer opens for this image, and the ledger has no new pin entry.
4. Submit the same manifest in prepare mode. Confirm the dashboard displays `ready`. Open **Preview and approval** and compare the preview. Then open the Pinterest draft from the dashboard. Compare the preview, title, description, destination URL, alt text, board, and Publish control against the manifest.
5. Check the test board and confirm the image has yet to be published. Use the dashboard's **Approve and publish this pin** control only if the authorized account owner explicitly wants this pin posted. Otherwise end the procedure at step 4.
6. After approval, compare any reported published URL with the actual pin. Confirm its image and metadata in Pinterest. If the dashboard reports `uncertain`, inspect the board manually before doing anything further. Never repeat the publish click to resolve ambiguity.
7. Resubmit the same bytes under a second filename and confirm the CLI reports the original pin ID as a duplicate. If testing batch preparation, use distinct images and verify individual preview and approval buttons. Repeat with a static WebP if needed.
8. For a negative test, edit a field in a fresh ready draft and then intentionally approve the original preview. The extension should block the publish click. Inspect abandoned drafts or remove them manually if approved.

Record browser/version, date, composer route, observed states, and any sanitized selector details. Keep account identifiers and bridge pairing codes out of logs.
