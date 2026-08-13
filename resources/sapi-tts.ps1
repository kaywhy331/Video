param(
  [Parameter(Mandatory=$true)][string]$TextPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [string]$TimingPath = "",
  [string]$VoiceName = "",
  [int]$Rate = 0,
  [int]$Volume = 100
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$text = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($VoiceName -ne "") {
  $synth.SelectVoice($VoiceName)
}
$synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
$synth.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))
$timings = New-Object System.Collections.Generic.List[object]
$handler = [System.EventHandler[System.Speech.Synthesis.SpeakProgressEventArgs]] {
  param($sender, $eventArgs)
  $timings.Add([PSCustomObject]@{
    word = $eventArgs.Text
    startMs = [int][Math]::Round($eventArgs.AudioPosition.TotalMilliseconds)
    characterPosition = $eventArgs.CharacterPosition
    characterCount = $eventArgs.CharacterCount
  })
}
$synth.add_SpeakProgress($handler)
$synth.SetOutputToWaveFile($OutputPath)
$synth.Speak($text)
$synth.remove_SpeakProgress($handler)
$synth.Dispose()
if ($TimingPath -ne "") {
  $items = @($timings)
  for ($i = 0; $i -lt $items.Count; $i++) {
    $next = if ($i + 1 -lt $items.Count) { $items[$i + 1].startMs } else { $null }
    $items[$i] | Add-Member -NotePropertyName endMs -NotePropertyValue $next
  }
  $items | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $TimingPath -Encoding UTF8
}
