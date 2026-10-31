//! Contador de não lidas no ícone do app (lógica pura): o texto da bandeja e o ícone sobreposto da barra de tarefas
//! do Windows (círculo vermelho com o número), gerado em RGBA sem nenhum arquivo de imagem nem fonte.
//!
//! * macOS: o Dock mostra o número (`set_badge_count`), nada daqui é usado;
//! * Windows: `set_overlay_icon` com `render_overlay`;
//! * Linux: `set_badge_count` (só onde o desktop oferece, ex.: Unity) e o título/tooltip da bandeja.

// O ícone sobreposto só existe no Windows (nos testes compila em qualquer SO).
/// Lado do ícone sobreposto (o Windows o reduz para ~16 px).
#[cfg(any(windows, test))]
pub const OVERLAY_SIZE: u32 = 32;

#[cfg(any(windows, test))]
const RED: [u8; 4] = [220, 38, 38, 255];
#[cfg(any(windows, test))]
const WHITE: [u8; 4] = [255, 255, 255, 255];

/// Texto curto do contador: `7`, `42`, `99+`.
pub fn label(count: u32) -> String {
    if count > 99 {
        "99+".into()
    } else {
        count.to_string()
    }
}

/// Texto da bandeja: `Spook` ou `Spook (3)`.
pub fn tooltip(count: u32) -> String {
    if count == 0 {
        "Spook".into()
    } else {
        format!("Spook ({})", label(count))
    }
}

#[cfg(any(windows, test))]
/// Glifos 3x5 (linhas de cima para baixo, bit 2 = coluna da esquerda).
fn glyph(c: char) -> [u8; 5] {
    match c {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b001, 0b001, 0b001],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => [0; 5],
    }
}

#[cfg(any(windows, test))]
/// Ícone sobreposto (RGBA, `OVERLAY_SIZE` x `OVERLAY_SIZE`) com o número; `None` para zero (remove o ícone).
pub fn render_overlay(count: u32) -> Option<(Vec<u8>, u32, u32)> {
    if count == 0 {
        return None;
    }
    let size = OVERLAY_SIZE as usize;
    let mut px = vec![0u8; size * size * 4];
    let put = |px: &mut [u8], x: usize, y: usize, c: [u8; 4]| {
        let i = (y * size + x) * 4;
        px[i..i + 4].copy_from_slice(&c);
    };
    // Círculo cheio.
    let r = size as f32 / 2.0;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 + 0.5 - r;
            let dy = y as f32 + 0.5 - r;
            if dx * dx + dy * dy <= (r - 0.5) * (r - 0.5) {
                put(&mut px, x, y, RED);
            }
        }
    }
    // Texto centralizado: a escala encolhe conforme o número de caracteres.
    let text = label(count);
    let n = text.chars().count();
    let scale = match n {
        1 => 4,
        2 => 3,
        _ => 2,
    };
    let width = n * 3 * scale + (n - 1) * scale;
    let height = 5 * scale;
    let x0 = (size - width) / 2;
    let y0 = (size - height) / 2;
    for (i, ch) in text.chars().enumerate() {
        let rows = glyph(ch);
        let gx = x0 + i * 4 * scale;
        for (row, bits) in rows.iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) != 0 {
                    for sy in 0..scale {
                        for sx in 0..scale {
                            put(&mut px, gx + col * scale + sx, y0 + row * scale + sy, WHITE);
                        }
                    }
                }
            }
        }
    }
    Some((px, OVERLAY_SIZE, OVERLAY_SIZE))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(img: &[u8], x: usize, y: usize) -> [u8; 4] {
        let i = (y * OVERLAY_SIZE as usize + x) * 4;
        [img[i], img[i + 1], img[i + 2], img[i + 3]]
    }

    #[test]
    fn labels_and_tooltips() {
        assert_eq!(label(1), "1");
        assert_eq!(label(99), "99");
        assert_eq!(label(100), "99+");
        assert_eq!(label(5000), "99+");
        assert_eq!(tooltip(0), "Spook");
        assert_eq!(tooltip(3), "Spook (3)");
        assert_eq!(tooltip(250), "Spook (99+)");
    }

    #[test]
    fn zero_removes_the_overlay() {
        assert!(render_overlay(0).is_none());
    }

    #[test]
    fn overlay_is_a_red_circle_with_white_digits_and_transparent_corners() {
        for n in [1, 7, 10, 42, 99, 100] {
            let (img, w, h) = render_overlay(n).unwrap();
            assert_eq!((w, h), (OVERLAY_SIZE, OVERLAY_SIZE));
            assert_eq!(img.len(), (w * h * 4) as usize);
            assert_eq!(at(&img, 0, 0)[3], 0, "canto transparente ({n})");
            assert_eq!(at(&img, 31, 31)[3], 0);
            let red = img.chunks(4).filter(|p| p == &RED).count();
            let white = img.chunks(4).filter(|p| p == &WHITE).count();
            assert!(red > 300, "fundo vermelho ({n}): {red}");
            assert!(white > 20, "números brancos ({n}): {white}");
        }
    }

    #[test]
    fn different_numbers_draw_different_icons() {
        let a = render_overlay(1).unwrap().0;
        let b = render_overlay(2).unwrap().0;
        let c = render_overlay(12).unwrap().0;
        assert_ne!(a, b);
        assert_ne!(a, c);
        // o 100 e o 5000 são o mesmo "99+"
        assert_eq!(
            render_overlay(100).unwrap().0,
            render_overlay(5000).unwrap().0
        );
    }

    #[test]
    fn digits_stay_inside_the_circle() {
        for n in [8, 88, 100] {
            let (img, _, _) = render_overlay(n).unwrap();
            // nenhuma margem de 3 px do canto é branca
            for (x, y) in [(2, 2), (29, 2), (2, 29), (29, 29)] {
                assert_ne!(at(&img, x, y), WHITE, "{n} em ({x},{y})");
            }
        }
    }
}
