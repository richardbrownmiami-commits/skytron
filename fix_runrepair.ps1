$s = Get-Content -LiteralPath "D:\Github\Skytron\chat.html" -Raw
$match = [regex]::Match($s, "<script>(.*?)</script>", [System.Text.RegularExpressions.RegexOptions]::Singleline)
if (-not $match.Success) { Write-Host "NO MATCH"; exit 1 }
$js = $match.Groups[1].Value.Trim()
$prefix = $js.Substring(0, $js.IndexOf("function runRepair"))
$rest = $js.Substring($js.IndexOf("function doRepair"))
$mid = $js.Substring($js.IndexOf("function runRepair"), $js.IndexOf("function doRepair") - $js.IndexOf("function runRepair"))
# Simple replacement
Write-Host ("Prefix len: " + $prefix.Length)
Write-Host ("Mid len: " + $mid.Length)
Write-Host ("Rest len: " + $rest.Length)
Write-Host ("Total: " + ($prefix.Length + $mid.Length + $rest.Length))
