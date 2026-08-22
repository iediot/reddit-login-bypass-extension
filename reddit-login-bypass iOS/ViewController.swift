// ViewController.swift — instructions for turning the extension on.
// iOS has no API for reading a Safari extension's state, so unlike the macOS
// app this screen cannot report whether it is already on.

import UIKit

class ViewController: UIViewController {

    private let steps = [
        "Open Settings ▸ Apps ▸ Safari ▸ Extensions.",
        "Turn on Reddit Login Bypass.",
        "Tap it, then allow it on reddit.com.",
        "Reload any Reddit tab that was already open.",
    ]

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let logo = UIImageView(image: UIImage(named: "AppLogo"))
        logo.contentMode = .scaleAspectFit
        logo.translatesAutoresizingMaskIntoConstraints = false
        logo.heightAnchor.constraint(equalToConstant: 96).isActive = true

        let title = UILabel()
        title.text = "Reddit Login Bypass"
        title.font = .preferredFont(forTextStyle: .title1)
        title.adjustsFontForContentSizeCategory = true
        title.textAlignment = .center

        let subtitle = UILabel()
        subtitle.text = "A Safari extension. Nothing to do here — it runs in Safari."
        subtitle.font = .preferredFont(forTextStyle: .subheadline)
        subtitle.adjustsFontForContentSizeCategory = true
        subtitle.textColor = .secondaryLabel
        subtitle.textAlignment = .center
        subtitle.numberOfLines = 0

        let stack = UIStackView(arrangedSubviews: [logo, title, subtitle])
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 12
        stack.setCustomSpacing(24, after: subtitle)

        for (index, step) in steps.enumerated() {
            stack.addArrangedSubview(stepLabel(index + 1, step))
        }

        var config = UIButton.Configuration.filled()
        config.title = "Open Settings"
        config.cornerStyle = .large
        let button = UIButton(configuration: config, primaryAction: UIAction { _ in
            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
            UIApplication.shared.open(url)
        })
        stack.setCustomSpacing(24, after: stack.arrangedSubviews.last!)
        stack.addArrangedSubview(button)

        stack.translatesAutoresizingMaskIntoConstraints = false
        let scrollView = UIScrollView()
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(stack)
        view.addSubview(scrollView)

        let guide = view.safeAreaLayoutGuide
        let content = scrollView.contentLayoutGuide
        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: guide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: guide.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: guide.trailingAnchor),

            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 32),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -32),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -48),
        ])
    }

    private func stepLabel(_ number: Int, _ text: String) -> UILabel {
        let label = UILabel()
        label.text = "\(number).  \(text)"
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        return label
    }

}
