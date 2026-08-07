if [ "$SHOULD_REMUX" -eq 1 ]; then
  echo "Mencoba remux (copy) ke mp4..."
  if ffmpeg -y -analyzeduration 100M -probesize 100M -i "$TEMP_FILE" -c copy "$FINAL_FILE"; then
    echo "✅ Remux berhasil: $FINAL_FILE"
    exit 0
  else
    echo "⚠️ Remux gagal — akan re-encode."
  fi
fi

# Re-encode fallback (handles png_pipe / image2-pipe cases)
echo "Melakukan re-encode video => H.264 + AAC (agar VLC/MP dapat memutar)..."
# use reasonable defaults; if resolution found we keep it; else ffmpeg will detect
if ffmpeg -y -analyzeduration 100M -probesize 100M -i "$TEMP_FILE" -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -c:a aac -b:a 128k "$FINAL_FILE"; then
  echo "✅ Re-encode selesai: $FINAL_FILE"
  exit 0
else
  echo "❌ Re-encode gagal."
  exit 1
fi