# Kod 1, jeśli którykolwiek proces (poza -IgnorePid) używa GPU powyżej progu na DOWOLNYM silniku (compute, 3D, video...).
param([int]$IgnorePid = 0, [double]$Threshold = 8)
$s = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples 2).CounterSamples |
  Where-Object { $_.CookedValue -gt $Threshold } |
  ForEach-Object { [pscustomobject]@{ pid = [int]($_.InstanceName -replace '.*pid_(\d+).*', '$1'); eng = ($_.InstanceName -replace '.*engtype_(\w+).*', '$1') } } |
  Where-Object { $_.pid -ne $IgnorePid } | ForEach-Object { (Get-Process -Id $_.pid -ErrorAction SilentlyContinue).ProcessName + '/' + $_.eng } | Sort-Object -Unique
if ($s) { Write-Output ("busy: " + ($s -join ',')); exit 1 } else { exit 0 }
