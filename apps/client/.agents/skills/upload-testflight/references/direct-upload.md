# Direct Build Upload API

Use the connected App Store Connect tools. Resolve opaque IDs at runtime; do
not hardcode the examples from an earlier release.

## 1. Create the upload

Call `POST /v1/buildUploads`:

```json
{
  "data": {
    "type": "buildUploads",
    "attributes": {
      "cfBundleShortVersionString": "MARKETING_VERSION",
      "cfBundleVersion": "BUILD_NUMBER",
      "platform": "IOS"
    },
    "relationships": {
      "app": {
        "data": {
          "type": "apps",
          "id": "APP_ID"
        }
      }
    }
  }
}
```

## 2. Reserve the IPA file

Read the IPA byte size with `stat -f '%z'`. Call
`POST /v1/buildUploadFiles`:

```json
{
  "data": {
    "type": "buildUploadFiles",
    "attributes": {
      "assetType": "ASSET",
      "fileName": "overseer_mobile.ipa",
      "fileSize": 123,
      "uti": "com.apple.ipa"
    },
    "relationships": {
      "buildUpload": {
        "data": {
          "type": "buildUploads",
          "id": "BUILD_UPLOAD_ID"
        }
      }
    }
  }
}
```

## 3. Upload every operation

Fetch `/v1/buildUploadFiles/FILE_ID` inside `functions.exec`, then upload all
operations without printing their signed URLs. Replace the three constants:

```js
const fileId = "FILE_ID";
const ipaPath = "/absolute/path/to/overseer_mobile.ipa";
const reservation =
  await tools.mcp__armory_app_store_connect__api_get({
    path: `/v1/buildUploadFiles/${fileId}`,
  });
const textBlock = reservation.content.find((item) => item.type === "text");
const operations =
  JSON.parse(textBlock.text).data.attributes.uploadOperations;
const results = await Promise.all(operations.map(async (operation) => {
  const skipMiB = Math.floor(operation.offset / 1048576);
  const safeUrl = operation.url.replace(/'/g, "'\\''");
  const command =
    `dd if='${ipaPath}' bs=1048576 skip=${skipMiB} 2>/dev/null | ` +
    `head -c ${operation.length} | ` +
    `curl -sS -o /dev/null -w '%{http_code}' ` +
    `-X ${operation.method} ` +
    `-H 'Content-Type: application/octet-stream' ` +
    `-H 'Content-Length: ${operation.length}' ` +
    `--data-binary @- '${safeUrl}'`;
  const result = await tools.exec_command({
    cmd: command,
    yield_time_ms: 30000,
    max_output_tokens: 1000,
  });
  return {
    part: operation.partNumber,
    status: result.output.trim(),
    exit: result.exit_code,
  };
}));
results.sort((left, right) => left.part - right.part);
results.forEach((result) =>
  text(`part ${result.part}: http=${result.status} exit=${result.exit}\n`));
if (results.some((result) =>
  result.exit !== 0 || !/^2\d\d$/.test(result.status))) {
  throw new Error("One or more upload parts failed");
}
```

## 4. Commit and monitor

Call `PATCH /v1/buildUploadFiles/FILE_ID`:

```json
{
  "data": {
    "type": "buildUploadFiles",
    "id": "FILE_ID",
    "attributes": {
      "uploaded": true
    }
  }
}
```

Require the file asset state to become `COMPLETE`. Poll
`/v1/buildUploads/BUILD_UPLOAD_ID?include=build`, then list app builds until
the matching build reaches `VALID`, `FAILED`, or `INVALID`.

Treat chunk HTTP 200 responses as transfer success only. Treat a visible
`builds` resource with `processingState: VALID` as release success.
