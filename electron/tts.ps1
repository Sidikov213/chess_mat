# Озвучка голосом Windows (OneCore: там есть мужской русский голос Pavel, которого нет в браузерном speechSynthesis).
# Читает из stdin строки «base64(UTF-8 текст)», на каждую пишет WAV во временный файл и печатает путь (или ERR ...).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -like '*Pavel*' } | Select-Object -First 1
if (-not $voice) { $voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.Language -like 'ru*' } | Select-Object -First 1 }
if ($voice) { $synth.Voice = $voice }
try { $synth.Options.SpeakingRate = 1.15; $synth.Options.AudioPitch = 0.9 } catch {}
[Console]::Out.WriteLine("READY $($synth.Voice.DisplayName)")
[Console]::Out.Flush()

$n = 0
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Trim()))
    $task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($synth.SynthesizeTextToStreamAsync($text)))
    $null = $task.Wait(-1)
    $src = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($task.Result)
    $n++
    $path = Join-Path $env:TEMP ("chess-coach-tts-{0}-{1}.wav" -f $PID, ($n % 4))
    $dst = [System.IO.File]::Create($path)
    $src.CopyTo($dst)
    $dst.Close()
    [Console]::Out.WriteLine($path)
  } catch {
    [Console]::Out.WriteLine("ERR $($_.Exception.Message)")
  }
  [Console]::Out.Flush()
}
