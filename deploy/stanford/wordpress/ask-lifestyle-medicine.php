<?php
/**
 * Plugin Name: Ask Lifestyle Medicine Embed
 * Description: Adds a secure Ask Lifestyle Medicine iframe or script-loader shortcode.
 * Version: 0.1.0
 */

if (!defined('ABSPATH')) {
    exit;
}

function alm_embed_shortcode($attributes) {
    $attributes = shortcode_atts(
        array(
            'origin' => 'https://ask.example.stanford.edu',
            'mode' => 'iframe',
            'height' => '760',
        ),
        $attributes,
        'ask_lifestyle_medicine'
    );

    $origin = untrailingslashit(esc_url_raw($attributes['origin']));
    $height = max(520, min(2400, absint($attributes['height'])));
    $mode = $attributes['mode'] === 'script' ? 'script' : 'iframe';
    $mount_id = wp_unique_id('ask-lifestyle-medicine-');

    if ($mode === 'script') {
        return sprintf(
            '<div id="%1$s"></div><script src="%2$s/ask-lifestyle-medicine-embed.js" data-target="%1$s" data-height="%3$d" defer></script>',
            esc_attr($mount_id),
            esc_url($origin),
            $height
        );
    }

    return sprintf(
        '<iframe src="%1$s/embed/slm" title="%2$s" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="clipboard-write" style="display:block;width:100%%;height:%3$dpx;border:0;background:#fff"></iframe>',
        esc_url($origin),
        esc_attr__('Ask Lifestyle Medicine', 'ask-lifestyle-medicine'),
        $height
    );
}
add_shortcode('ask_lifestyle_medicine', 'alm_embed_shortcode');