# Runbook: Browser Capture

## Build/Package Extension

```bash
cd backend
npm run zip:extension
```

The backend production build also runs the extension packaging step.

## Pair
Create a pairing code from Settings, open the extension, and register the device before the pairing code expires. The device token is then used for heartbeat and resource submission.

## Diagnose No Captures

1. Check extension permissions and manifest configuration.
2. Check background/content-script logs.
3. Check filtering/classification tests.
4. Check browser-extension CORS origin handling in the backend.
5. Check `/browser-capture/heartbeat` and device status.
6. Check captured-resource expiry/status.

## Import Failure
Confirm the resource is still `pending`, then check import options, destination storage, whether Remote Import is enabled, and request context when the source requires Referer/cookies.
