<?php
// Custo do hash de senha em PHP, na mesma máquina, para comparar com o Argon2id do Spook.
// Mede password_hash e password_verify (o que o Laravel chama em Hash::make / Hash::check).
//
// Uso:  php bench/scripts/hash-cost.php [iterações=20]
//   Local, em Docker:  docker run --rm -v "$PWD/bench/scripts:/s:ro" php:8.4-cli php /s/hash-cost.php
//   No VPS, dentro do container do app do antrax (mesmo PHP e mesma CPU da produção), com o script por stdin:
//     ssh gustavo@<vps> "sudo -iu antrax docker exec -i <container-do-app> php" < bench/scripts/hash-cost.php
// Saída: mediana (e mínimo/máximo) em ms por operação.

$n = (int) ($argv[1] ?? 20);
$pw = 'senha-de-teste-123';

function bench(string $label, callable $f, int $n): void
{
    $f(); // aquece
    $t = [];
    for ($i = 0; $i < $n; $i++) {
        $s = hrtime(true);
        $f();
        $t[] = (hrtime(true) - $s) / 1e6;
    }
    sort($t);
    $med = $n % 2 ? $t[intdiv($n, 2)] : ($t[$n / 2 - 1] + $t[$n / 2]) / 2;
    printf("%-58s mediana %8.2f ms   min %8.2f   max %8.2f   (n=%d)\n", $label, $med, $t[0], $t[$n - 1], $n);
}

printf("PHP %s (%s)\n\n", PHP_VERSION, php_uname('m'));

// antrax: bcrypt, BCRYPT_ROUNDS=12 (config/hashing.php padrão do Laravel + .env.prod.example)
foreach ([10, 12, 13] as $cost) {
    $enc = password_hash($pw, PASSWORD_BCRYPT, ['cost' => $cost]);
    bench("bcrypt cost $cost  hash".($cost === 12 ? '   <- antrax' : ''), fn () => password_hash($pw, PASSWORD_BCRYPT, ['cost' => $cost]), $n);
    bench("bcrypt cost $cost  verify".($cost === 12 ? ' <- antrax' : ''), fn () => password_verify($pw, $enc), $n);
}

if (defined('PASSWORD_ARGON2ID')) {
    echo "\n";
    // Spook: Argon2id m=19456 KiB (19 MiB), t=2, p=1 — mesmos parâmetros, implementação C (libargon2) do PHP
    $spook = ['memory_cost' => 19456, 'time_cost' => 2, 'threads' => 1];
    $enc = password_hash($pw, PASSWORD_ARGON2ID, $spook);
    bench('argon2id m=19456 t=2 p=1  hash   (parâmetros do Spook)', fn () => password_hash($pw, PASSWORD_ARGON2ID, $spook), $n);
    bench('argon2id m=19456 t=2 p=1  verify (parâmetros do Spook)', fn () => password_verify($pw, $enc), $n);

    // Padrão do Laravel se o driver fosse argon2id (config/hashing.php: 65536 KiB, t=4, p=1)
    $lara = ['memory_cost' => 65536, 'time_cost' => 4, 'threads' => 1];
    $enc = password_hash($pw, PASSWORD_ARGON2ID, $lara);
    bench('argon2id m=65536 t=4 p=1  verify (padrão argon do Laravel)', fn () => password_verify($pw, $enc), $n);
}
