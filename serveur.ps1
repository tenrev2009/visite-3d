# Petit serveur web local pour ouvrir la visite sur ce PC (aucune installation).
# Les navigateurs refusent d'ouvrir une visite 3D directement depuis le disque :
# ce script la sert a l'adresse http://localhost:8080/ tant que la fenetre est ouverte.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8080
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Visite disponible sur http://localhost:$port/  (fermez cette fenetre pour l'arreter)"
Start-Process "http://localhost:$port/"

$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8';
  '.json' = 'application/json; charset=utf-8'; '.glb' = 'model/gltf-binary';
  '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.png' = 'image/png'; '.css' = 'text/css'
}

while ($listener.IsListening) {
  $context = $listener.GetContext()
  $path = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
  if ($path -eq '') { $path = 'index.html' }
  $file = Join-Path $root $path
  $response = $context.Response
  try {
    if ((Test-Path $file -PathType Leaf) -and ([IO.Path]::GetFullPath($file).StartsWith($root))) {
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $response.ContentType = $(if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' })
      $stream = [IO.File]::OpenRead($file)
      $response.ContentLength64 = $stream.Length
      if ($context.Request.HttpMethod -ne 'HEAD') { $stream.CopyTo($response.OutputStream, 1048576) }
      $stream.Close()
    } else {
      $response.StatusCode = 404
    }
  } catch {
    $response.StatusCode = 500
  } finally {
    $response.OutputStream.Close()
  }
}
